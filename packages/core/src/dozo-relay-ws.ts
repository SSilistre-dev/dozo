import { RelayPeerMessageSchema, RelayRecordType } from "@rakazo/contracts";
import type { RelayDuplex, RelayReceiver } from "./dozo-relay-channel.js";

/**
 * One relay WebSocket below the sealed channel, on either end. The socket outlives sessions: the
 * host starts a new one on every `hello`, the app each time the relay says the host is present,
 * and either ends when the other end leaves. Socket rules: `dozo/relay/PROTOCOL.md`, Sockets.
 */

/** What the layer reads off a socket event; the standard WebSocket and Node's `ws` both fit. */
export type RelaySocketEvent = { type?: string; data?: unknown; code?: number; reason?: string };

/** The standard WebSocket surface the layer uses: browsers, React Native, Node and `ws`. */
export type RelayWebSocket = {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: RelaySocketEvent) => void,
  ): void;
};

export type RelaySocketOptions = {
  role: "app" | "host";
  /** A new session over this socket; it ends when a newer one starts or the other end leaves. */
  onSession(session: RelayDuplex): void;
  onPeer?(present: boolean): void;
  /** The socket is gone (closed, failed or silent); open sessions were closed with the same error. */
  onClose?(error: RelaySocketClosedError): void;
  pingIntervalMs?: number;
  silenceMs?: number;
};

export type RelaySocket = {
  readonly peerPresent: boolean;
  close(reason?: string): void;
};

export class RelaySocketClosedError extends Error {
  override name = "RelaySocketClosedError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const OPEN = 1;
const PING_INTERVAL_MS = 25_000;
const SILENCE_MS = 75_000;
/** The close code for an end that closes on its own: a normal closure. */
const NORMAL = 1000;
/** What a socket reports when it went away without a close frame. */
const ABNORMAL = 1006;

class Session implements RelayDuplex {
  private receiver: RelayReceiver | null = null;
  private pending: Uint8Array[] = [];
  private failure: Error | null = null;

  constructor(private readonly socket: RelayWebSocket) {}

  send(data: Uint8Array) {
    if (!this.failure && this.socket.readyState === OPEN) this.socket.send(data);
  }

  close(reason: string) {
    this.end(new Error(reason));
  }

  attach(receiver: RelayReceiver) {
    this.receiver = receiver;
    for (const data of this.pending.splice(0)) receiver.receive(data);
    if (this.failure) receiver.closed(this.failure);
  }

  deliver(data: Uint8Array) {
    if (this.failure) return;
    if (this.receiver) this.receiver.receive(data);
    else this.pending.push(data);
  }

  end(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.pending = [];
    this.receiver?.closed(error);
  }
}

/** Wraps an open relay socket; the caller keeps no other listener on it. */
export function wsDuplex(socket: RelayWebSocket, options: RelaySocketOptions): RelaySocket {
  socket.binaryType = "arraybuffer";
  let session: Session | null = null;
  let peerPresent = false;
  let closed = false;
  let silence: ReturnType<typeof setTimeout> | undefined;
  const silenceMs = options.silenceMs ?? SILENCE_MS;

  const ping = setInterval(() => {
    if (socket.readyState === OPEN) socket.send("ping");
  }, options.pingIntervalMs ?? PING_INTERVAL_MS);

  const endSession = (error: Error) => {
    session?.end(error);
    session = null;
  };
  const startSession = (first?: Uint8Array) => {
    endSession(new Error("a new session started"));
    const next = new Session(socket);
    session = next;
    if (first) next.deliver(first);
    options.onSession(next);
  };
  const finish = (error: RelaySocketClosedError, closeSocket: boolean) => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    clearTimeout(silence);
    if (closeSocket) socket.close(NORMAL, error.message);
    endSession(error);
    options.onClose?.(error);
  };
  const heard = () => {
    clearTimeout(silence);
    silence = setTimeout(
      () => finish(new RelaySocketClosedError(ABNORMAL, "relay socket went silent"), true),
      silenceMs,
    );
  };

  const onText = (text: string) => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return; // `pong`, or anything else a newer relay may say
    }
    const peer = RelayPeerMessageSchema.safeParse(message);
    if (!peer.success) return;
    peerPresent = peer.data.present;
    options.onPeer?.(peerPresent);
    if (!peerPresent) endSession(new Error("the other end left"));
    else if (options.role === "app") startSession();
  };

  socket.addEventListener("message", (event) => {
    if (closed) return;
    heard();
    const { data } = event;
    if (typeof data === "string") return onText(data);
    const bytes = asBytes(data);
    if (!bytes) return;
    if (options.role === "host" && bytes[0] === RelayRecordType.hello) startSession(bytes);
    else session?.deliver(bytes);
  });
  socket.addEventListener("close", (event) => {
    const code = event.code ?? ABNORMAL;
    const reason = event.reason ? ` ${event.reason}` : "";
    finish(new RelaySocketClosedError(code, `relay socket closed (${code}${reason})`), false);
  });
  socket.addEventListener("error", () =>
    finish(new RelaySocketClosedError(ABNORMAL, "relay socket error"), true),
  );
  heard();

  return {
    get peerPresent() {
      return peerPresent;
    },
    close: (reason = "closed") => finish(new RelaySocketClosedError(NORMAL, reason), true),
  };
}

function asBytes(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
