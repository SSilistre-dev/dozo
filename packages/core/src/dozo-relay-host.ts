import {
  RELAY_PAIRING_TTL_MS,
  RELAY_PROTOCOL_VERSION,
  RelayPairingOfferSchema,
  RelayRegisterResponseSchema,
} from "@rakazo/contracts";
import { abortableDelay } from "./async.js";
import type { RelayChannel, RelayCrypto, RelayDuplex, RelayKeyPair } from "./dozo-relay-channel.js";
import {
  acceptHostChannel,
  decodeRelayBytes,
  encodeRelayBytes,
  encodeRelayPairingOffer,
  relayAppToken,
  relayPairingSecrets,
  relayVerifier,
} from "./dozo-relay-channel.js";
import { serveRelay } from "./dozo-relay-mux.js";
import type { RelaySocketClosedError, RelayWebSocket } from "./dozo-relay-ws.js";
import { wsDuplex } from "./dozo-relay-ws.js";
import { retry } from "./retry.js";
import { parseRetryAfter, reconnectDelayMs } from "./retry-policy.js";

/**
 * The computer's end of the relay: makes pairing offers, keeps one relay socket per channel and
 * forwards each sealed request to the user's loopback server. Storage, sockets and HTTP are passed
 * in, so the same code runs wherever the host agent runs. Pairing: `dozo/relay/PROTOCOL.md`.
 */

/** One channel as the host stores it. Keys and tokens are base64url. */
export type RelayHostChannel = {
  channel: string;
  relay: string;
  hostToken: string;
  createdAt: number;
  /** While the offer is open: the first session's key and when the offer ends. */
  pairing: { psk: string; expiresAt: number } | null;
  /** After pairing: the phone's public key and the key of every later session. */
  app: { key: string; pairingKey: string; verifierSet: boolean; pairedAt: number } | null;
};

/** Where the host keeps its key pair and channels; a file today, the OS key store later. */
export type RelayHostStore = {
  /** The host's long-term key pair, made with `create` the first time. */
  hostKey(create: () => Promise<RelayKeyPair>): Promise<RelayKeyPair>;
  list(): Promise<RelayHostChannel[]>;
  put(channel: RelayHostChannel): Promise<void>;
  remove(channel: string): Promise<void>;
  /** Calls back when the store may have changed under this process; returns the stop function. */
  watch?(onChange: () => void): () => void;
};

/** Opens a socket to the relay with the token, or rejects (with `RelayHttpError` when refused). */
export type RelayConnect = (
  url: string,
  token: string,
  signal: AbortSignal,
) => Promise<RelayWebSocket>;

export type RelayHostEvent =
  | { event: "connected"; channel: string }
  | { event: "peer"; channel: string; present: boolean }
  | { event: "paired"; channel: string; appKey: string }
  | { event: "disconnected"; channel: string; reason: string; retryInMs: number }
  | { event: "refused"; channel: string; reason: string }
  | { event: "revoked"; channel: string }
  | { event: "expired"; channel: string }
  | { event: "error"; channel?: string; reason: string };

export class RelayHostError extends Error {
  override name = "RelayHostError";
}

/** The relay refused a request or an upgrade; `retryAfterMs` is the wait a 429 asked for. */
export class RelayHttpError extends Error {
  override name = "RelayHttpError";
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`relay answered ${status}`);
  }
}

type HostDeps = {
  store: RelayHostStore;
  crypto: RelayCrypto;
  fetch?: typeof fetch;
  now?: () => number;
};

const HTTP_ATTEMPTS = 4;

/**
 * Registers a channel and returns the offer text for the QR code. The offer works once, for ten
 * minutes, and only while `runRelayHost` is connected for this store.
 */
export async function pairRelayHost(deps: HostDeps & { relay: string }) {
  const { store, crypto } = deps;
  const relay = relayBase(deps.relay);
  const now = deps.now ?? Date.now;
  const hostKey = await store.hostKey(() => crypto.generateKeyPair());
  const secret = crypto.randomBytes(32);
  const { psk, token } = await relayPairingSecrets(crypto, secret);
  const hostToken = encodeRelayBytes(crypto.randomBytes(32));
  const expiresAt = now() + RELAY_PAIRING_TTL_MS;
  const body = {
    hostVerifier: await relayVerifier(crypto, hostToken),
    pairVerifier: await relayVerifier(crypto, token),
    pairExpiresAt: expiresAt,
  };
  const answer = await retry(
    async () => {
      const response = await relayHttp(deps, relay, "POST", "/v1/channels", null, body);
      return response.json();
    },
    { attempts: HTTP_ATTEMPTS },
  );
  const parsed = RelayRegisterResponseSchema.safeParse(answer);
  if (!parsed.success) throw new RelayHostError("relay answered with an unexpected body");
  const { channel } = parsed.data;
  // Ids are file names on a case-insensitive disk; a relay must not replace a pairing by reusing one.
  const held = await store.list();
  if (held.some((entry) => entry.channel.toLowerCase() === channel.toLowerCase())) {
    throw new RelayHostError("relay returned a channel that is already paired");
  }
  await store.put({
    channel,
    relay,
    hostToken,
    createdAt: now(),
    pairing: { psk: encodeRelayBytes(psk), expiresAt },
    app: null,
  });
  const offer = encodeRelayPairingOffer({
    v: RELAY_PROTOCOL_VERSION,
    relay,
    channel,
    hostKey: encodeRelayBytes(hostKey.publicKey),
    secret: encodeRelayBytes(secret),
    expiresAt,
  });
  return { channel, relay, expiresAt, offer };
}

/** What each channel is, without its keys or tokens. */
export async function listRelayChannels(store: RelayHostStore) {
  return (await store.list()).map((entry) =>
    entry.app
      ? {
          channel: entry.channel,
          relay: entry.relay,
          state: "paired" as const,
          appKey: entry.app.key,
          pairedAt: entry.app.pairedAt,
        }
      : {
          channel: entry.channel,
          relay: entry.relay,
          state: "pairing" as const,
          expiresAt: entry.pairing?.expiresAt,
        },
  );
}

/**
 * Removes a pairing: deletes the channel on the relay, which closes both sockets, and forgets its
 * keys. The keys go even when the relay cannot be reached: without them nothing answers the phone.
 */
export async function revokeRelayChannel(
  deps: HostDeps & { channel: string; attempts?: number },
): Promise<{ relay: "deleted" | "unreachable" }> {
  const entry = (await deps.store.list()).find((item) => item.channel === deps.channel);
  if (!entry) throw new RelayHostError("no such channel");
  let relay: "deleted" | "unreachable" = "deleted";
  try {
    await retry(
      () =>
        relayHttp(
          deps,
          entry.relay,
          "DELETE",
          `/v1/channels/${entry.channel}`,
          entry.hostToken,
        ).then(() => undefined),
      { attempts: deps.attempts ?? HTTP_ATTEMPTS },
    );
  } catch (error) {
    if (!(error instanceof RelayHttpError && error.status === 404)) relay = "unreachable";
  }
  await deps.store.remove(entry.channel);
  return { relay };
}

export type RelayHostOptions = HostDeps & {
  connect: RelayConnect;
  /** The loopback server requests go to, such as `http://127.0.0.1:3000`. */
  origin: string;
  forward?: (request: Request) => Promise<Response>;
  onEvent(event: RelayHostEvent): void;
  /** Stops everything; the promise resolves once the sockets are closed. */
  signal: AbortSignal;
  random?: () => number;
};

/** Stays connected for every stored channel, following the store, until the signal aborts. */
export async function runRelayHost(options: RelayHostOptions) {
  const { signal } = options;
  if (signal.aborted) return;
  const loops = new Map<string, ChannelLoop>();
  let hostKey: RelayKeyPair | null = null;
  let syncing = Promise.resolve();

  const sync = () => {
    syncing = syncing.then(async () => {
      if (signal.aborted) return;
      try {
        hostKey ??= await options.store.hostKey(() => options.crypto.generateKeyPair());
        const entries = await options.store.list();
        const ids = new Set(entries.map((entry) => entry.channel));
        for (const [id, loop] of loops) {
          if (!ids.has(id)) {
            loop.stop();
            loops.delete(id);
          }
        }
        // A channel's file changes only through its own loop after it starts (pair adds files,
        // revoke removes them), so a running loop keeps its own copy, never an older read.
        for (const entry of entries) {
          if (!loops.has(entry.channel)) {
            const started = new ChannelLoop(options, hostKey, entry, () => {
              if (loops.get(entry.channel) === started) loops.delete(entry.channel);
            });
            loops.set(entry.channel, started);
            started.start();
          }
        }
      } catch (error) {
        options.onEvent({ event: "error", reason: message(error) });
        await abortableDelay(1000, signal);
        sync();
      }
    });
  };

  const unwatch = options.store.watch?.(sync);
  sync();
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  unwatch?.();
  await syncing;
  await Promise.all([...loops.values()].map((loop) => loop.stop()));
}

/** Thrown when the relay no longer knows the channel: its keys are useless now. */
class ChannelGone extends Error {}
/** A socket that was open closed; the next connect starts its backoff again. */
class ConnectionLost extends Error {}

class ChannelLoop {
  private readonly controller = new AbortController();
  private done: Promise<void> = Promise.resolve();
  private pairingDone = false;

  constructor(
    private readonly options: RelayHostOptions,
    private readonly hostKey: RelayKeyPair,
    private entry: RelayHostChannel,
    private readonly onEnd: () => void,
  ) {
    options.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  private get id() {
    return this.entry.channel;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  start() {
    this.done = Promise.all([this.connectLoop(), this.expiry()]).then(() => this.onEnd());
  }

  stop() {
    this.controller.abort();
    return this.done;
  }

  /** Ends an offer nobody used: the relay refuses its token by then too. */
  private async expiry() {
    const { signal } = this.controller;
    while (!signal.aborted && !this.entry.app && this.entry.pairing) {
      const left = this.entry.pairing.expiresAt - this.now();
      if (left <= 0) {
        this.controller.abort();
        await this.options.store
          .remove(this.id)
          .catch((error: unknown) =>
            this.options.onEvent({ event: "error", channel: this.id, reason: message(error) }),
          );
        this.options.onEvent({ event: "expired", channel: this.id });
        return;
      }
      await abortableDelay(Math.min(left, 1000), signal);
    }
  }

  private async connectLoop() {
    const { signal } = this.controller;
    while (!signal.aborted) {
      try {
        await retry(() => this.connectOnce(), {
          attempts: Number.POSITIVE_INFINITY,
          signal,
          random: this.options.random,
          retryable: (error) =>
            !signal.aborted &&
            !(error instanceof ChannelGone) &&
            !(error instanceof ConnectionLost),
          onRetry: (error, _attempt, retryInMs) => this.disconnected(error, retryInMs),
        });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ChannelGone) {
          await this.options.store.remove(this.id);
          this.options.onEvent({ event: "revoked", channel: this.id });
          return;
        }
        // The socket had been open: spread the reconnects of every host a relay restart cut off.
        const retryInMs = reconnectDelayMs(error, this.options.random);
        this.disconnected(error, retryInMs);
        await abortableDelay(retryInMs, signal);
      }
    }
  }

  private disconnected(error: unknown, retryInMs: number) {
    this.options.onEvent({
      event: "disconnected",
      channel: this.id,
      reason: message(error),
      retryInMs,
    });
  }

  /** One socket's life: resolves when stopped, rejects when it could not open or closed. */
  private async connectOnce() {
    const { signal } = this.controller;
    if (this.entry.app && !this.entry.app.verifierSet) await this.setAppVerifier();
    let socket: RelayWebSocket;
    try {
      socket = await this.options.connect(
        `${this.entry.relay.replace(/^http/, "ws")}/v1/channels/${this.id}/host`,
        this.entry.hostToken,
        signal,
      );
    } catch (error) {
      if (error instanceof RelayHttpError && error.status === 404) throw new ChannelGone();
      throw error;
    }
    this.options.onEvent({ event: "connected", channel: this.id });
    await new Promise<void>((resolve, reject) => {
      const relay = wsDuplex(socket, {
        role: "host",
        onSession: (session) => this.accept(session),
        onPeer: (present) => this.options.onEvent({ event: "peer", channel: this.id, present }),
        onClose: (error: RelaySocketClosedError) => {
          signal.removeEventListener("abort", stop);
          if (signal.aborted) resolve();
          else reject(new ConnectionLost(error.message));
        },
      });
      const stop = () => relay.close("stopping");
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }

  private accept(session: RelayDuplex) {
    const { app, pairing } = this.entry;
    if (!app && pairing && pairing.expiresAt <= this.now()) {
      session.close("pairing offer expired");
      this.options.onEvent({ event: "refused", channel: this.id, reason: "pairing offer expired" });
      return;
    }
    const psk = app?.pairingKey ?? pairing?.psk;
    if (!psk) return session.close("not paired");
    acceptHostChannel({
      crypto: this.options.crypto,
      transport: session,
      channel: this.id,
      psk: decodeRelayBytes(psk),
      hostKey: this.hostKey,
      appKey: app ? decodeRelayBytes(app.key) : null,
    }).then(
      (channel) => {
        const transport = app ? channel : this.firstRecord(channel);
        serveRelay(transport, {
          origin: this.options.origin,
          forward: this.options.forward ?? ((request) => fetch(request)),
        });
      },
      (error: unknown) =>
        this.options.onEvent({ event: "refused", channel: this.id, reason: message(error) }),
    );
  }

  /** Completes pairing once the phone's first record opens: it proves the phone has the session. */
  private firstRecord(channel: RelayChannel): RelayDuplex {
    let seen = false;
    return {
      send: (data) => channel.send(data),
      close: (reason) => channel.close(reason),
      attach: (receiver) =>
        channel.attach({
          receive: (data) => {
            if (!seen) {
              seen = true;
              void this.completePairing(channel);
            }
            receiver.receive(data);
          },
          closed: (error) => receiver.closed(error),
        }),
    };
  }

  private async completePairing(channel: RelayChannel) {
    if (this.pairingDone || this.entry.app) return channel.close("already paired");
    this.pairingDone = true;
    const appKey = encodeRelayBytes(channel.peerKey);
    this.entry = {
      ...this.entry,
      pairing: null,
      app: {
        key: appKey,
        pairingKey: encodeRelayBytes(channel.pairingKey),
        verifierSet: false,
        pairedAt: this.now(),
      },
    };
    try {
      await this.options.store.put(this.entry);
      await this.setAppVerifier();
      this.options.onEvent({ event: "paired", channel: this.id, appKey });
    } catch (error) {
      // Stored but not on the relay yet: the next connect sets the verifier again.
      this.options.onEvent({ event: "error", channel: this.id, reason: message(error) });
    }
  }

  private async setAppVerifier() {
    const app = this.entry.app as NonNullable<RelayHostChannel["app"]>;
    const { crypto } = this.options;
    const token = await relayAppToken(crypto, decodeRelayBytes(app.pairingKey));
    const body = { appVerifier: await relayVerifier(crypto, token) };
    await retry(
      () =>
        relayHttp(
          this.options,
          this.entry.relay,
          "PUT",
          `/v1/channels/${this.id}/app`,
          this.entry.hostToken,
          body,
        ),
      { attempts: HTTP_ATTEMPTS, signal: this.controller.signal, random: this.options.random },
    );
    this.entry = { ...this.entry, app: { ...app, verifierSet: true } };
    await this.options.store.put(this.entry);
  }
}

/** The relay's base address without a trailing slash; https, or http on loopback. */
function relayBase(value: string) {
  const trimmed = value.replace(/\/+$/, "");
  // The schema's https check parses the address itself, and throws on one that is not a URL.
  if (!URL.canParse(trimmed) || !RelayPairingOfferSchema.shape.relay.safeParse(trimmed).success)
    throw new RelayHostError("relay address must be https");
  return trimmed;
}

async function relayHttp(
  deps: { fetch?: typeof fetch },
  relay: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await (deps.fetch ?? fetch)(`${relay}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new RelayHttpError(response.status, parseRetryAfter(response.headers.get("retry-after")));
  }
  return response;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
