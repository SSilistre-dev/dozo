import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayDuplex } from "./dozo-relay-channel.js";
import {
  acceptHostChannel,
  openAppChannel,
  relayPairingSecrets,
  webRelayCrypto,
} from "./dozo-relay-channel.js";
import { relayClient, serveRelay } from "./dozo-relay-mux.js";
import { RelaySocketClosedError, wsDuplex } from "./dozo-relay-ws.js";

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** A socket as the relay end sees it: `deliver` plays the relay, `sent` is what the end wrote. */
function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const socket = {
    binaryType: "blob",
    readyState: 1,
    sent: [] as (string | Uint8Array)[],
    closedWith: null as { code?: number; reason?: string } | null,
    send(data: string | Uint8Array) {
      socket.sent.push(typeof data === "string" ? data : data.slice());
    },
    close(code?: number, reason?: string) {
      socket.closedWith = { code, reason };
      socket.readyState = 3;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event: Parameters<Listener>[0]) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    deliver(data: unknown) {
      socket.emit("message", { data });
    },
    peer(present: boolean) {
      socket.deliver(JSON.stringify({ type: "peer", present }));
    },
  };
  return socket;
}

/** Two fake sockets joined the way the relay joins them, forwarding binary messages only. */
function relayedSockets() {
  const app = fakeSocket();
  const host = fakeSocket();
  const forward = (from: typeof app, to: typeof app) => {
    const send = from.send.bind(from);
    from.send = (data) => {
      send(data);
      if (typeof data !== "string") queueMicrotask(() => to.deliver(data.slice().buffer));
    };
  };
  forward(app, host);
  forward(host, app);
  return { app, host };
}

function receiverOf(duplex: RelayDuplex) {
  const got = { messages: [] as Uint8Array[], closed: null as Error | null };
  duplex.attach({
    receive: (data) => got.messages.push(data),
    closed: (error) => {
      got.closed = error;
    },
  });
  return got;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wsDuplex", () => {
  it("asks for array buffers and starts a host session on every hello, ending the last one", () => {
    const socket = fakeSocket();
    const sessions: RelayDuplex[] = [];
    wsDuplex(socket, { role: "host", onSession: (session) => sessions.push(session) });
    expect(socket.binaryType).toBe("arraybuffer");

    socket.deliver(new Uint8Array([3, 9]).buffer);
    expect(sessions).toHaveLength(0);

    socket.deliver(new Uint8Array([1, 7]).buffer);
    const first = receiverOf(sessions[0] as RelayDuplex);
    expect(first.messages).toEqual([new Uint8Array([1, 7])]);
    socket.deliver(new Uint8Array([3, 8]));
    expect(first.messages[1]).toEqual(new Uint8Array([3, 8]));

    socket.deliver(new Uint8Array([1, 6]).buffer);
    expect(first.closed?.message).toBe("a new session started");
    const second = receiverOf(sessions[1] as RelayDuplex);
    expect(second.messages).toEqual([new Uint8Array([1, 6])]);
    expect(socket.closedWith).toBeNull();
  });

  it("starts an app session each time the host is present and ends it when the host goes", () => {
    const socket = fakeSocket();
    const sessions: RelayDuplex[] = [];
    const peers: boolean[] = [];
    const relay = wsDuplex(socket, {
      role: "app",
      onSession: (session) => sessions.push(session),
      onPeer: (present) => peers.push(present),
    });
    socket.peer(false);
    expect(sessions).toHaveLength(0);
    expect(relay.peerPresent).toBe(false);

    socket.peer(true);
    expect(relay.peerPresent).toBe(true);
    const session = sessions[0] as RelayDuplex;
    const got = receiverOf(session);
    session.send(new Uint8Array([1, 2]));
    expect(socket.sent).toEqual([new Uint8Array([1, 2])]);
    // A hello reaching the app is just a message for the open session.
    socket.deliver(new Uint8Array([1, 0]).buffer);
    expect(sessions).toHaveLength(1);
    expect(got.messages).toEqual([new Uint8Array([1, 0])]);

    socket.peer(false);
    expect(got.closed?.message).toBe("the other end left");
    session.send(new Uint8Array([3]));
    expect(socket.sent).toHaveLength(1);
    expect(peers).toEqual([false, true, false]);
  });

  it("ignores text it does not know and a binary message with no session", () => {
    const socket = fakeSocket();
    const onSession = vi.fn();
    wsDuplex(socket, { role: "app", onSession });
    socket.deliver("pong");
    socket.deliver("{not json");
    socket.deliver(JSON.stringify({ type: "other" }));
    socket.deliver(new Uint8Array([3, 1]).buffer);
    socket.deliver(42);
    expect(onSession).not.toHaveBeenCalled();
    expect(socket.closedWith).toBeNull();
  });

  it("closing a session leaves the socket open, and a closed session sends nothing", () => {
    const socket = fakeSocket();
    let session: RelayDuplex | null = null;
    wsDuplex(socket, {
      role: "host",
      onSession: (next) => {
        session = next;
      },
    });
    socket.deliver(new Uint8Array([1]).buffer);
    const open = session as unknown as RelayDuplex;
    open.close("handshake failed");
    open.send(new Uint8Array([2]));
    const late = receiverOf(open);
    expect(late.closed?.message).toBe("handshake failed");
    expect(socket.sent).toHaveLength(0);
    expect(socket.closedWith).toBeNull();
  });

  it("does not write to a socket that is no longer open", () => {
    const socket = fakeSocket();
    const sessions: RelayDuplex[] = [];
    wsDuplex(socket, { role: "app", onSession: (session) => sessions.push(session) });
    socket.peer(true);
    socket.readyState = 2;
    sessions[0]?.send(new Uint8Array([1]));
    expect(socket.sent).toHaveLength(0);
  });

  it("reports the relay closing the socket once, with its code, and ends the session", () => {
    const socket = fakeSocket();
    const sessions: RelayDuplex[] = [];
    const onClose = vi.fn();
    wsDuplex(socket, { role: "app", onSession: (session) => sessions.push(session), onClose });
    socket.peer(true);
    const got = receiverOf(sessions[0] as RelayDuplex);
    socket.emit("close", { code: 4000, reason: "replaced" });
    socket.emit("error", {});
    expect(onClose).toHaveBeenCalledTimes(1);
    const error = onClose.mock.calls[0]?.[0] as RelaySocketClosedError;
    expect(error).toBeInstanceOf(RelaySocketClosedError);
    expect(error.code).toBe(4000);
    expect(error.message).toBe("relay socket closed (4000 replaced)");
    expect(got.closed).toBe(error);
    socket.peer(true);
    expect(sessions).toHaveLength(1);
  });

  it("treats a socket error as a close", () => {
    const socket = fakeSocket();
    const onClose = vi.fn();
    wsDuplex(socket, { role: "host", onSession: vi.fn(), onClose });
    socket.emit("error", {});
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 1006 }));
    expect(socket.closedWith).toEqual({ code: 1000, reason: "relay socket error" });
  });

  it("closes the socket itself on request", () => {
    const socket = fakeSocket();
    const onClose = vi.fn();
    const relay = wsDuplex(socket, { role: "host", onSession: vi.fn(), onClose });
    relay.close("stopping");
    relay.close("again");
    expect(socket.closedWith).toEqual({ code: 1000, reason: "stopping" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: "stopping" }));
  });

  it("pings while open and gives the socket up after the silence limit", () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const onClose = vi.fn();
    wsDuplex(socket, {
      role: "host",
      onSession: vi.fn(),
      onClose,
      pingIntervalMs: 100,
      silenceMs: 300,
    });
    vi.advanceTimersByTime(250);
    expect(socket.sent).toEqual(["ping", "ping"]);
    socket.deliver("pong");
    vi.advanceTimersByTime(250);
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onClose).toHaveBeenCalledWith(
      expect.objectContaining({ message: "relay socket went silent" }),
    );
    expect(socket.closedWith?.code).toBe(1000);
    const pings = socket.sent.length;
    vi.advanceTimersByTime(1000);
    expect(socket.sent).toHaveLength(pings);
  });

  it("carries a sealed channel and the multiplexer between two ends", async () => {
    const crypto = webRelayCrypto();
    const { app, host } = relayedSockets();
    const hostKey = await crypto.generateKeyPair();
    const appKey = await crypto.generateKeyPair();
    const { psk } = await relayPairingSecrets(crypto, crypto.randomBytes(32));
    const channel = "AAAAAAAAAAAAAAAAAAAAAA";

    wsDuplex(host, {
      role: "host",
      onSession: (transport) => {
        void acceptHostChannel({ crypto, transport, channel, psk, hostKey, appKey: null }).then(
          (sealed) =>
            serveRelay(sealed, {
              origin: "http://127.0.0.1:3000",
              forward: async (request) => Response.json({ path: new URL(request.url).pathname }),
            }),
        );
      },
    });
    const opened = new Promise<RelayDuplex>((resolve, reject) => {
      wsDuplex(app, {
        role: "app",
        onSession: (transport) => {
          openAppChannel({
            crypto,
            transport,
            channel,
            psk,
            appKey,
            hostKey: hostKey.publicKey,
          }).then(resolve, reject);
        },
      });
    });
    app.peer(true);
    const client = relayClient(await opened);
    const response = await client.fetch("/hello");
    expect(await response.json()).toEqual({ path: "/hello" });
    client.close();
  });
});
