import type { RelayAppPairing, RelayPairingOffer } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import type {
  RelayClient,
  RelayConnect,
  RelayCrypto,
  RelayKeyPair,
  RelaySocket,
  RelayWebTypes,
} from "@rakazo/core";
import {
  decodeRelayBytes,
  encodeRelayBytes,
  openAppChannel,
  parseRelayPairingOffer,
  RelayHttpError,
  relayAppToken,
  relayClient,
  relayPairingSecrets,
  wsDuplex,
} from "@rakazo/core";

/**
 * The phone's end of the relay: pairs with the computer from its offer and carries the app's
 * requests to it. The paired computer is a server like any other to the rest of the app: its own
 * `https` origin, which no network can resolve (`.invalid`), so only this module answers it.
 * Protocol: `dozo/relay/PROTOCOL.md`.
 */

/** What the phone keeps after pairing (`RelayAppPairingSchema`). */
export type RelayPairing = RelayAppPairing;

export type RelayPairingStore = {
  load(): Promise<RelayPairing | null>;
  save(pairing: RelayPairing): Promise<void>;
  clear(): Promise<void>;
};

export type RelayDeps = {
  crypto: RelayCrypto;
  /** Opens a socket with the token in the upgrade; rejects with `RelayHttpError` when refused. */
  connect: RelayConnect;
  web: RelayWebTypes;
  now?: () => number;
  /** How long a request waits for the computer before it fails like an unreachable server. */
  sessionWaitMs?: number;
};

const SESSION_WAIT_MS = 8_000;
/** The relay closes a socket with this code once the channel is deleted (`PROTOCOL.md`, Sockets). */
const CLOSE_DELETED = 4001;
/** After pairing, the computer sets the phone's token on the relay; until then a 404 is expected. */
const PAIRING_GRACE_MS = 2 * 60_000;

/** The failure every caller already handles for a server that does not answer. */
export class RelayUnreachableError extends TypeError {
  override name = "RelayUnreachableError";
  constructor(readonly reason: string) {
    super("Network request failed");
  }
}

/** Why pairing did not complete, in terms the pairing screen words for the user. */
export class RelayPairingError extends Error {
  override name = "RelayPairingError";
  constructor(
    readonly kind: "invalid" | "expired" | "used" | "unreachable" | "not-dozo",
    options?: { cause?: unknown },
  ) {
    super(`pairing failed: ${kind}`, options);
  }
}

export const RELAY_HOST_SUFFIX = ".computer.dozo.invalid";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/**
 * The server address the app uses for a paired computer. Its name is random, not the channel id:
 * whatever the system still loads by this address on its own (an image, say) asks DNS for a name
 * that says nothing about the channel.
 */
export function relayOrigin(originId: string) {
  return `https://${originId}${RELAY_HOST_SUFFIX}`;
}

export function isRelayOrigin(origin: string) {
  return /^https:\/\/[0-9a-f]{32}\.computer\.dozo\.invalid$/.test(origin);
}

/** The offer in a pasted text: the offer itself or a link carrying it after `#`. */
export function offerText(input: string) {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  return hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
}

/** The offer in a scanned link or pasted text, checked before the user is asked anything. */
export function readPairingOffer(input: string, now: number): RelayPairingOffer {
  try {
    return parseRelayPairingOffer(offerText(input), now);
  } catch (error) {
    throw new RelayPairingError(
      error instanceof Error && error.message.includes("expired") ? "expired" : "invalid",
    );
  }
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The one body a request may carry here: what `init` gives, else a `Request`'s readable stream. */
function requestOptions(input: RequestInfo | URL, init: RequestInit = {}) {
  if (typeof input !== "object" || !("method" in input))
    return { url: String(input), options: init };
  const request = input as Request & { _bodyInit?: unknown };
  // React Native's Request keeps its body where only its own fetch reads it: say so, never drop it.
  if (init.body === undefined && !request.body && request._bodyInit != null) {
    throw new TypeError("pass the body in the second argument when the request goes to a computer");
  }
  const options: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: request.body ?? undefined,
    signal: request.signal,
    redirect: request.redirect,
    ...init,
  };
  return { url: request.url, options };
}

type Mode =
  | { kind: "paired"; pairing: RelayPairing }
  | {
      kind: "pairing";
      originId: string;
      relay: string;
      channel: string;
      hostKey: string;
      appKey: RelayKeyPair;
      psk: Uint8Array;
      token: string;
      pairingKey: Uint8Array | null;
    };

type Waiter = { resolve: (client: RelayClient) => void; reject: (error: Error) => void };

/** One computer: a relay socket opened on demand, and a client for each session on it. */
export class RelayConnection {
  readonly origin: string;
  private socket: RelaySocket | null = null;
  private opening: AbortController | null = null;
  private client: RelayClient | null = null;
  private sessions = 0;
  private closed = false;
  private readonly waiters = new Set<Waiter>();
  /** Set when the relay no longer knows the channel: the computer removed this phone. */
  onGone?: () => void;
  /** Whether the relay says the computer is connected; null while no socket is open. */
  computerPresent: boolean | null = null;
  /** Called whenever `computerPresent` changes. */
  onPresence?: () => void;

  constructor(
    private readonly deps: RelayDeps,
    private mode: Mode,
  ) {
    this.origin = relayOrigin(mode.kind === "paired" ? mode.pairing.originId : mode.originId);
  }

  get channel() {
    return this.mode.kind === "paired" ? this.mode.pairing.channel : this.mode.channel;
  }

  /**
   * `fetch` for this computer's origin. A computer that does not answer fails like a server. A
   * redirect is followed on the computer only; one that leaves it fails, as no request may go
   * anywhere else under this address.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let { url, options } = requestOptions(input, init);
    for (let hops = 0; ; hops++) {
      const response = await this.send(url, options);
      if (!REDIRECTS.has(response.status) || options.redirect === "manual") return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel();
      const next = new URL(location, url);
      if (options.redirect === "error" || next.origin !== this.origin || hops >= MAX_REDIRECTS) {
        throw new TypeError(`redirect to ${next.origin} not followed`);
      }
      const method = (options.method ?? "GET").toUpperCase();
      if (response.status === 303 || (response.status < 303 && method === "POST")) {
        options = { ...options, method: "GET", body: undefined };
      } else if (options.body instanceof ReadableStream) {
        throw new TypeError("a streamed body cannot be sent again after a redirect");
      }
      url = next.href;
    }
  }

  private async send(url: string, options: RequestInit) {
    const client = await this.session(options.signal ?? undefined);
    try {
      return await client.fetch(url, options);
    } catch (error) {
      if (options.signal?.aborted || error instanceof TypeError) throw error;
      // Only a session that ended is left; a refused request (too many open) leaves it in use.
      if (client.failed) this.retire(client);
      throw new RelayUnreachableError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Drops a client whose session ended and the socket under it: the next request reconnects. */
  private retire(client: RelayClient) {
    if (this.client !== client) return;
    this.client = null;
    this.socket?.close("session failed");
  }

  close() {
    this.closed = true;
    this.opening?.abort();
    this.socket?.close("closed");
    this.drop(new RelayUnreachableError("closed"));
  }

  /** The pairing record, once the first session gave the phone its pairing key. */
  pairing(): RelayPairing | null {
    if (this.mode.kind === "paired") return this.mode.pairing;
    const { originId, relay, channel, hostKey, appKey, pairingKey } = this.mode;
    if (!pairingKey) return null;
    return {
      originId,
      relay,
      channel,
      hostKey,
      appPublicKey: encodeRelayBytes(appKey.publicKey),
      appPrivateKey: encodeRelayBytes(appKey.privateKey),
      pairingKey: encodeRelayBytes(pairingKey),
      pairedAt: (this.deps.now ?? Date.now)(),
    };
  }

  /** After the first request answered: later sockets use the phone's own token. */
  confirmPaired(pairing: RelayPairing) {
    this.mode = { kind: "paired", pairing };
  }

  private session(signal?: AbortSignal): Promise<RelayClient> {
    if (this.closed) return Promise.reject(new RelayUnreachableError("closed"));
    if (this.client?.failed) this.retire(this.client);
    if (this.client) return Promise.resolve(this.client);
    return new Promise<RelayClient>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (client) => {
          finish();
          resolve(client);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      const timer = setTimeout(
        () => waiter.reject(new RelayUnreachableError("the computer did not answer")),
        this.deps.sessionWaitMs ?? SESSION_WAIT_MS,
      );
      // A runtime whose signal carries no reason still rejects with an abort error, never undefined.
      const onAbort = () =>
        waiter.reject(signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
      if (!this.socket && !this.opening) void this.open();
    });
  }

  private async open() {
    const controller = new AbortController();
    this.opening = controller;
    const { relay, channel } = this.mode.kind === "paired" ? this.mode.pairing : this.mode;
    try {
      const token =
        this.mode.kind === "paired"
          ? await relayAppToken(this.deps.crypto, decodeRelayBytes(this.mode.pairing.pairingKey))
          : this.mode.token;
      const socket = await this.deps.connect(
        `${relay.replace(/^http/, "ws")}/v1/channels/${channel}/app`,
        token,
        controller.signal,
      );
      if (this.closed) {
        socket.close(1000, "closed");
        return;
      }
      this.socket = wsDuplex(socket, {
        role: "app",
        onSession: (session) => {
          const id = ++this.sessions;
          this.client = null;
          const keys = this.keys();
          openAppChannel({ crypto: this.deps.crypto, transport: session, channel, ...keys }).then(
            (sealed) => {
              if (id !== this.sessions || this.closed) return sealed.close("superseded");
              // Only the pairing session's key is kept: every later session derives its own.
              if (this.mode.kind === "pairing" && !this.mode.pairingKey) {
                this.mode.pairingKey = sealed.pairingKey;
              }
              const client = relayClient(sealed, this.deps.web);
              this.client = client;
              for (const waiter of [...this.waiters]) waiter.resolve(client);
            },
            (error: unknown) => this.drop(new RelayUnreachableError(String(error))),
          );
        },
        onPeer: (present) => {
          if (!present) this.client = null;
          this.present(present);
        },
        onClose: (error) => {
          this.socket = null;
          this.present(null);
          this.drop(new RelayUnreachableError(error.message));
          // The channel was deleted under an open socket: removed at once, no reconnect needed.
          // No grace as for a 404 (`refused`): that one is expected right after pairing, until the
          // computer sets the phone's token. The relay sends 4001 only for a deleted or replaced
          // channel, which no pairing in progress produces.
          if (error.code === CLOSE_DELETED && this.mode.kind === "paired" && !this.closed) {
            this.onGone?.();
          }
        },
      });
    } catch (error) {
      this.drop(this.refused(error));
    } finally {
      this.opening = null;
    }
  }

  private present(value: boolean | null) {
    if (this.computerPresent === value) return;
    this.computerPresent = value;
    this.onPresence?.();
  }

  private keys() {
    if (this.mode.kind === "pairing") {
      const { appKey, hostKey, psk, pairingKey } = this.mode;
      return { appKey, hostKey: decodeRelayBytes(hostKey), psk: pairingKey ?? psk };
    }
    const { pairing } = this.mode;
    return {
      appKey: {
        publicKey: decodeRelayBytes(pairing.appPublicKey),
        privateKey: decodeRelayBytes(pairing.appPrivateKey),
      },
      hostKey: decodeRelayBytes(pairing.hostKey),
      psk: decodeRelayBytes(pairing.pairingKey),
    };
  }

  /** A refused upgrade: a 404 means the computer removed this phone (or the offer is spent). */
  private refused(error: unknown): Error {
    if (!(error instanceof RelayHttpError) || error.status !== 404) {
      return new RelayUnreachableError(error instanceof Error ? error.message : String(error));
    }
    if (this.mode.kind === "pairing") return new RelayPairingError("used");
    const age = (this.deps.now ?? Date.now)() - this.mode.pairing.pairedAt;
    if (age > PAIRING_GRACE_MS) this.onGone?.();
    return new RelayUnreachableError("the computer removed this phone");
  }

  private drop(error: Error) {
    this.client = null;
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
}

/** A connection for a stored pairing. */
export function pairedConnection(deps: RelayDeps, pairing: RelayPairing) {
  return new RelayConnection(deps, { kind: "paired", pairing });
}

/**
 * Pairs with the computer whose offer the user scanned or pasted and agreed to: one session with
 * the offer's secret, then a first request, which completes the pairing on the computer and proves
 * a Dozo server answers. Resolves with the live connection and the record to store.
 */
export async function pairRelay(
  offer: RelayPairingOffer,
  deps: RelayDeps,
): Promise<{ connection: RelayConnection; pairing: RelayPairing }> {
  const { psk, token } = await relayPairingSecrets(deps.crypto, decodeRelayBytes(offer.secret));
  const connection = new RelayConnection(deps, {
    kind: "pairing",
    originId: hex(deps.crypto.randomBytes(16)),
    relay: offer.relay.replace(/\/+$/, ""),
    channel: offer.channel,
    hostKey: offer.hostKey,
    appKey: await deps.crypto.generateKeyPair(),
    psk,
    token,
    pairingKey: null,
  });
  try {
    const response = await connection.fetch(`${connection.origin}/rpc/health`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      body: JSON.stringify({ json: {} }),
    });
    const body = (await bestEffort("read the health answer", response.json())) as
      | { json?: { ok?: unknown } }
      | undefined;
    if (!response.ok || body?.json?.ok !== true) throw new RelayPairingError("not-dozo");
  } catch (error) {
    connection.close();
    if (error instanceof RelayPairingError) throw error;
    throw new RelayPairingError("unreachable", { cause: error });
  }
  const pairing = connection.pairing();
  /* v8 ignore next: a request answered over a session, so the session gave its key. */
  if (!pairing) throw new RelayPairingError("unreachable");
  connection.confirmPaired(pairing);
  return { connection, pairing };
}
