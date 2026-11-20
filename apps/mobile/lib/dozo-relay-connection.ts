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

/** What the phone keeps after pairing, base64url; the pairing secret itself is never stored. */
export type RelayPairing = {
  relay: string;
  channel: string;
  hostKey: string;
  appPublicKey: string;
  appPrivateKey: string;
  /** The key of the pairing session, the `psk` of every later one. */
  pairingKey: string;
  pairedAt: number;
};

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

const ORIGIN_SUFFIX = ".computer.dozo.invalid";

/** The server address the app uses for a paired computer: one per channel. */
export function relayOrigin(channel: string) {
  const hex = [...decodeRelayBytes(channel)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `https://${hex.join("")}${ORIGIN_SUFFIX}`;
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

type Mode =
  | { kind: "paired"; pairing: RelayPairing }
  | {
      kind: "pairing";
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

  constructor(
    private readonly deps: RelayDeps,
    private mode: Mode,
  ) {
    this.origin = relayOrigin(mode.kind === "paired" ? mode.pairing.channel : mode.channel);
  }

  /** `fetch` for this computer's origin. A computer that does not answer fails like a server. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = typeof input === "object" && "method" in input ? input : null;
    const url = request ? request.url : String(input);
    const options: RequestInit = request
      ? {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: request.signal,
          ...init,
        }
      : (init ?? {});
    const client = await this.session(options.signal ?? undefined);
    try {
      return await client.fetch(url, options);
    } catch (error) {
      if (options.signal?.aborted || error instanceof TypeError) throw error;
      // A session that failed under a request is not used again: the next request reconnects.
      if (this.client === client) {
        this.client = null;
        this.socket?.close("session failed");
      }
      throw new RelayUnreachableError(error instanceof Error ? error.message : String(error));
    }
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
    const { relay, channel, hostKey, appKey, pairingKey } = this.mode;
    if (!pairingKey) return null;
    return {
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
      const onAbort = () => waiter.reject(signal?.reason);
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
        },
        onClose: (error) => {
          this.socket = null;
          this.drop(new RelayUnreachableError(error.message));
        },
      });
    } catch (error) {
      this.drop(this.refused(error));
    } finally {
      this.opening = null;
    }
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
 * Pairs with the computer whose offer the user scanned or pasted: one session with the offer's
 * secret, then a first request, which completes the pairing on the computer and proves a Dozo
 * server answers. Resolves with the live connection and the record to store.
 */
export async function pairRelay(
  input: string,
  deps: RelayDeps,
): Promise<{ connection: RelayConnection; pairing: RelayPairing }> {
  const now = (deps.now ?? Date.now)();
  let offer: ReturnType<typeof parseRelayPairingOffer>;
  try {
    offer = parseRelayPairingOffer(offerText(input), now);
  } catch (error) {
    throw new RelayPairingError(
      error instanceof Error && error.message.includes("expired") ? "expired" : "invalid",
    );
  }
  const { psk, token } = await relayPairingSecrets(deps.crypto, decodeRelayBytes(offer.secret));
  const connection = new RelayConnection(deps, {
    kind: "pairing",
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
    const body = (await response.json().catch(() => null)) as { json?: { ok?: unknown } } | null;
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
