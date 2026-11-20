import { RELAY_MAX_STREAMS } from "@rakazo/contracts";
import type { RelaySocketEvent, RelayWebSocket } from "@rakazo/core";
import {
  acceptHostChannel,
  decodeRelayBytes,
  encodeRelayBytes,
  RelayHttpError,
  relayAppToken,
  serveRelay,
  webRelayCrypto,
} from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayWorld } from "./dozo-relay.test-support";
import type { RelayConnection, RelayPairing } from "./dozo-relay-connection";
import {
  isRelayOrigin,
  offerText,
  pairedConnection,
  pairRelay,
  RelayPairingError,
  RelayUnreachableError,
  readPairingOffer,
  relayOrigin,
} from "./dozo-relay-connection";

let world: Awaited<ReturnType<typeof relayWorld>>;
const open: RelayConnection[] = [];

beforeEach(async () => {
  world = await relayWorld();
});

afterEach(async () => {
  for (const connection of open.splice(0)) connection.close();
  await world.close();
});

/** The computer's offer as the phone reads it from the QR code's link. */
async function offer() {
  return readPairingOffer(await world.offer(), Date.now());
}

async function paired(deps = world.deps()) {
  world.startHost();
  const result = await pairRelay(await offer(), deps);
  open.push(result.connection);
  // The computer completes the pairing on the first record and sets the phone's token.
  await vi.waitFor(() => expect(world.events.some((event) => event.event === "paired")).toBe(true));
  await vi.waitFor(() =>
    expect([...world.store.channels.values()][0]?.app?.verifierSet).toBe(true),
  );
  return result;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string) {
  let seen = "";
  while (!seen.includes(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before ${text}`);
    seen += new TextDecoder().decode(value);
  }
  return seen;
}

/**
 * A relay socket whose far end the test plays: the relay's peer message, then the computer's end
 * of the channel with the stored keys, answering every request with its path.
 */
async function scriptedComputer(pairing: RelayPairing) {
  const hostKey = await world.store.hostKey(async () => {
    throw new Error("the computer has a key");
  });
  const sockets: ScriptedSocket[] = [];
  const connect = async () => {
    const socket = new ScriptedSocket();
    sockets.push(socket);
    const { host } = socket;
    void acceptHostChannel({
      crypto: webRelayCrypto(),
      transport: host,
      channel: pairing.channel,
      psk: decodeRelayBytes(pairing.pairingKey),
      hostKey,
      appKey: decodeRelayBytes(pairing.appPublicKey),
    }).then((channel) =>
      serveRelay(channel, {
        origin: "http://127.0.0.1:1",
        forward: async (request) => new Response(new URL(request.url).pathname),
      }),
    );
    return socket as RelayWebSocket;
  };
  return { sockets, connect };
}

class ScriptedSocket {
  binaryType = "arraybuffer";
  readyState = 1;
  closed = false;
  private readonly listeners = new Map<string, ((event: RelaySocketEvent) => void)[]>();
  private hostReceiver: { receive(data: Uint8Array): void } | null = null;
  readonly host = {
    send: (data: Uint8Array) => queueMicrotask(() => this.receive(data)),
    close: () => undefined,
    attach: (receiver: { receive(data: Uint8Array): void }) => {
      this.hostReceiver = receiver;
    },
  };
  addEventListener(type: string, listener: (event: RelaySocketEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    // The relay says the computer is there once the phone listens, as on a real socket.
    if (type === "message") {
      queueMicrotask(() =>
        this.emit("message", { data: JSON.stringify({ type: "peer", present: true }) }),
      );
    }
  }
  send(data: Uint8Array | string) {
    if (typeof data !== "string") queueMicrotask(() => this.hostReceiver?.receive(data));
  }
  /** A binary message from the computer's side reaching the phone. */
  receive(data: Uint8Array) {
    this.emit("message", { data: data.slice().buffer });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
  private emit(type: string, event: RelaySocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("addresses", () => {
  it("gives each pairing its own unresolvable https origin, named apart from the channel", async () => {
    expect(relayOrigin("ab".repeat(16))).toBe(`https://${"ab".repeat(16)}.computer.dozo.invalid`);
    expect(isRelayOrigin(relayOrigin("ab".repeat(16)))).toBe(true);
    expect(isRelayOrigin("https://app.dozo.bot")).toBe(false);
    expect(isRelayOrigin(`http://${"ab".repeat(16)}.computer.dozo.invalid`)).toBe(false);
    const { pairing } = await paired();
    const channelHex = [...decodeRelayBytes(pairing.channel)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(relayOrigin(pairing.originId)).not.toContain(channelHex);
  });

  it("takes the offer from a link or as pasted", () => {
    expect(offerText(" rakazo://dozo-pair#abc ")).toBe("abc");
    expect(offerText("abc\n")).toBe("abc");
  });
});

describe("pairing", () => {
  it("pairs from the QR code's link and keeps only the pairing session's key", async () => {
    const { connection, pairing } = await paired();
    const host = [...world.store.channels.values()][0];
    expect(pairing.channel).toBe(host?.channel);
    expect(pairing.relay).toBe(world.relayUrl);
    expect(pairing.pairingKey).toBe(host?.app?.pairingKey);
    expect(pairing.appPublicKey).toBe(host?.app?.key);
    expect(connection.origin).toBe(relayOrigin(pairing.originId));
    expect(connection.channel).toBe(pairing.channel);
    expect(connection.pairing()).toEqual(pairing);
  });

  it("keeps working on the pairing's connection after the computer restarts", async () => {
    const { connection, pairing } = await paired();
    await world.stopHost();
    world.startHost();
    // The new session's key comes from the pairing session; a later session's key would not open.
    await vi.waitFor(async () =>
      expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true),
    );
    expect(connection.pairing()).toEqual(pairing);
  });

  it("refuses text that is not an offer, and an expired offer, before sending anything", async () => {
    expect(() => readPairingOffer("rakazo://dozo-pair#nope", Date.now())).toThrow(
      expect.objectContaining({ kind: "invalid" }),
    );
    const link = await world.offer(() => Date.now() - 11 * 60_000);
    expect(() => readPairingOffer(link, Date.now())).toThrow(
      expect.objectContaining({ kind: "expired" }),
    );
  });

  it("refuses an offer that was already used", async () => {
    world.startHost();
    const once = await offer();
    open.push((await pairRelay(once, world.deps())).connection);
    await vi.waitFor(() =>
      expect([...world.store.channels.values()][0]?.app?.verifierSet).toBe(true),
    );
    await expect(pairRelay(once, world.deps())).rejects.toMatchObject({ kind: "used" });
  });

  it("fails as unreachable when the computer is not running", async () => {
    const unused = await offer();
    await expect(pairRelay(unused, world.deps({ sessionWaitMs: 200 }))).rejects.toMatchObject({
      kind: "unreachable",
    });
  });

  it("refuses a computer whose server is not a Dozo server", async () => {
    world.local.setHealthy(false);
    world.startHost();
    await expect(pairRelay(await offer(), world.deps())).rejects.toMatchObject({
      kind: "not-dozo",
    });
  });

  it("fails as unreachable when the relay cannot be reached", async () => {
    const unused = await offer();
    await world.close();
    await expect(pairRelay(unused, world.deps())).rejects.toBeInstanceOf(RelayPairingError);
    world = await relayWorld();
  });
});

describe("requests", () => {
  it("carries requests, bodies and headers to the computer's server", async () => {
    const { connection } = await paired();
    const echo = await connection.fetch(`${connection.origin}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "computer" }),
    });
    expect(echo.status).toBe(200);
    expect(echo.headers.get("x-method")).toBe("POST");
    expect(await echo.json()).toEqual({ hello: "computer" });
    const missing = await connection.fetch(new URL(`${connection.origin}/missing`));
    expect(missing.status).toBe(404);
    const big = await connection.fetch(`${connection.origin}/big?n=700000`);
    expect((await big.arrayBuffer()).byteLength).toBe(700_000);
  });

  it("takes a Request-like input with its own method and body", async () => {
    const { connection } = await paired();
    const input = {
      url: `${connection.origin}/echo`,
      method: "PUT",
      headers: new Headers({ "content-type": "text/plain" }),
      body: new Blob(["unused"]).stream(),
      signal: new AbortController().signal,
    } as unknown as Request;
    const response = await connection.fetch(input, { body: "from init" });
    expect(response.headers.get("x-method")).toBe("PUT");
    expect(await response.text()).toBe("from init");
  });

  it("refuses a React Native request whose body it cannot read, instead of dropping it", async () => {
    const { connection } = await paired();
    const input = {
      url: `${connection.origin}/echo`,
      method: "POST",
      headers: new Headers(),
      body: undefined,
      _bodyInit: "lost",
      signal: new AbortController().signal,
    } as unknown as Request;
    await expect(connection.fetch(input)).rejects.toThrow("second argument");
    const streamed = {
      url: `${connection.origin}/echo`,
      method: "POST",
      headers: new Headers(),
      body: new Response("streamed").body,
      signal: new AbortController().signal,
    } as unknown as Request;
    expect(await (await connection.fetch(streamed)).text()).toBe("streamed");
  });

  it("follows a redirect on the computer and refuses one that leaves it", async () => {
    const { connection } = await paired();
    const moved = (to: string, status = 302) =>
      `${connection.origin}/moved?status=${status}&to=${encodeURIComponent(to)}`;
    const followed = await connection.fetch(moved("/echo"), { method: "POST", body: "x" });
    expect(followed.headers.get("x-method")).toBe("GET");
    const kept = await connection.fetch(moved("/echo", 307), { method: "POST", body: "kept" });
    expect(await kept.text()).toBe("kept");
    const manual = await connection.fetch(moved("/echo"), { redirect: "manual" });
    expect(manual.status).toBe(302);
    await expect(connection.fetch(moved("/echo"), { redirect: "error" })).rejects.toThrow(
      "not followed",
    );
    await expect(connection.fetch(moved("https://elsewhere.invalid/"))).rejects.toThrow(
      "not followed",
    );
    await expect(connection.fetch(`${connection.origin}/loop`)).rejects.toThrow("not followed");
    expect((await connection.fetch(`${connection.origin}/moved?status=301`)).status).toBe(301);
    await expect(
      connection.fetch(moved("/echo", 308), { method: "PUT", body: new Response("s").body }),
    ).rejects.toThrow("streamed body");
  });

  it("refuses a request over the open-stream limit and keeps the session for the rest", async () => {
    const connect = vi.fn(world.deps().connect);
    const { connection } = await paired(world.deps({ connect }));
    const controller = new AbortController();
    const hanging = Array.from({ length: RELAY_MAX_STREAMS }, () =>
      connection
        .fetch(`${connection.origin}/hang`, { signal: controller.signal })
        .catch(() => null),
    );
    await vi.waitFor(async () =>
      expect(connection.fetch(`${connection.origin}/rpc/health`)).rejects.toMatchObject({
        reason: "too many open requests",
      }),
    );
    controller.abort();
    await Promise.all(hanging);
    expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("rejects an abort whose signal carries no reason with an abort error", async () => {
    const pairing = (await paired()).pairing;
    const connection = pairedConnection(world.deps(), pairing);
    open.push(connection);
    const signal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    await expect(
      connection.fetch(`${connection.origin}/rpc/health`, { signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("streams a live event stream as it arrives", async () => {
    const { connection } = await paired();
    const response = await connection.fetch(`${connection.origin}/events`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect(await readUntil(reader, "first")).toContain("data: first");
    world.local.emit("second");
    expect(await readUntil(reader, "second")).toContain("data: second");
    await reader.cancel();
    await vi.waitFor(() => expect(world.local.listeners()).toBe(0));
  });

  it("cancels a request when its signal aborts", async () => {
    const { connection } = await paired();
    const controller = new AbortController();
    const pending = connection.fetch(`${connection.origin}/hang`, { signal: controller.signal });
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const early = new AbortController();
    early.abort(new DOMException("early", "AbortError"));
    await expect(
      connection.fetch(`${connection.origin}/echo`, { signal: early.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a body the relay cannot carry without breaking the connection", async () => {
    const { connection } = await paired();
    await expect(
      connection.fetch(`${connection.origin}/echo`, { method: "POST", body: new FormData() }),
    ).rejects.toBeInstanceOf(TypeError);
    expect((await connection.fetch(`${connection.origin}/rpc/health`)).status).toBe(200);
  });
});

describe("a stored pairing", () => {
  async function stored(): Promise<RelayPairing> {
    const { connection, pairing } = await paired();
    connection.close();
    return pairing;
  }

  it("reconnects with the phone's own token and serves requests", async () => {
    const pairing = await stored();
    const connection = pairedConnection(world.deps(), pairing);
    open.push(connection);
    expect(connection.pairing()).toBe(pairing);
    expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true);
  });

  it("fails like an unreachable server while the computer is off, and recovers once it is back", async () => {
    const pairing = await stored();
    await world.stopHost();
    const connection = pairedConnection(world.deps({ sessionWaitMs: 300 }), pairing);
    open.push(connection);
    await expect(connection.fetch(`${connection.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    world.startHost();
    await vi.waitFor(async () =>
      expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true),
    );
  });

  it("fails an open request when the relay drops, then reconnects on the next one", async () => {
    const pairing = await stored();
    const connection = pairedConnection(world.deps(), pairing);
    open.push(connection);
    const response = await connection.fetch(`${connection.origin}/events`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, "first");
    await world.restartRelay();
    await expect(readUntil(reader, "never")).rejects.toBeTruthy();
    await vi.waitFor(async () =>
      expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true),
    );
  });

  it("forgets the pairing when the computer removed this phone, but not right after pairing", async () => {
    const pairing = await stored();
    // The relay forgets the channel, as when the computer removes the phone.
    const token = await relayAppToken(world.deps().crypto, decodeRelayBytes(pairing.pairingKey));
    const revoked = await fetch(`${world.relayUrl}/v1/channels/${pairing.channel}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(204);
    // The computer notices too and forgets the channel's keys.
    await vi.waitFor(() =>
      expect(world.events.some((event) => event.event === "revoked")).toBe(true),
    );
    expect(world.store.channels.size).toBe(0);

    const fresh = pairedConnection(world.deps(), pairing);
    open.push(fresh);
    const freshGone = vi.fn();
    fresh.onGone = freshGone;
    await expect(fresh.fetch(`${fresh.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    expect(freshGone).not.toHaveBeenCalled();

    const old = pairedConnection(world.deps({ now: () => pairing.pairedAt + 3 * 60_000 }), pairing);
    open.push(old);
    const gone = vi.fn();
    old.onGone = gone;
    await expect(old.fetch(`${old.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    expect(gone).toHaveBeenCalledOnce();
  });

  it("keeps the session when one request is refused before it is sent", async () => {
    const pairing = await stored();
    const connect = vi.fn(world.deps().connect);
    const connection = pairedConnection(world.deps({ connect }), pairing);
    open.push(connection);
    await expect(
      connection.fetch(`${connection.origin}/echo`, { headers: { "x-big": "a".repeat(40_000) } }),
    ).rejects.toMatchObject({ reason: "request head too large" });
    expect((await connection.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("drops a session that ended under its socket and reconnects for the next request", async () => {
    const pairing = await stored();
    const computer = await scriptedComputer(pairing);
    const connection = pairedConnection(world.deps({ connect: computer.connect }), pairing);
    open.push(connection);
    expect(await (await connection.fetch(`${connection.origin}/a`)).text()).toBe("/a");
    // A record the phone cannot open ends the session; the socket stays up.
    computer.sockets[0]?.receive(new Uint8Array(30).fill(3));
    await expect(connection.fetch(`${connection.origin}/b`)).resolves.toBeTruthy();
    expect(computer.sockets).toHaveLength(2);
    expect(computer.sockets[0]?.closed).toBe(true);
  });

  it("fails like an unreachable server when the computer refuses the session", async () => {
    const pairing = await stored();
    const stranger = await world.deps().crypto.generateKeyPair();
    const connection = pairedConnection(world.deps(), {
      ...pairing,
      appPrivateKey: encodeRelayBytes(stranger.privateKey),
      appPublicKey: encodeRelayBytes(stranger.publicKey),
    });
    open.push(connection);
    await expect(connection.fetch(`${connection.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    await vi.waitFor(() =>
      expect(world.events.some((event) => event.event === "refused")).toBe(true),
    );
  });

  it("does not connect for a request aborted before it starts", async () => {
    const pairing = await stored();
    const connect = vi.fn(world.deps().connect);
    const connection = pairedConnection(world.deps({ connect }), pairing);
    open.push(connection);
    const controller = new AbortController();
    controller.abort();
    await expect(
      connection.fetch(`${connection.origin}/rpc/health`, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("fails every request after it is closed", async () => {
    const pairing = await stored();
    const connection = pairedConnection(world.deps(), pairing);
    connection.close();
    await expect(connection.fetch(`${connection.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
  });

  it("closes a socket that opens after it was closed", async () => {
    const pairing = await stored();
    const gate = deferred<void>();
    const opened: { readyState: number }[] = [];
    const deps = world.deps({
      connect: async (url, token) => {
        await gate.promise;
        const socket = await world.deps().connect(url, token, new AbortController().signal);
        opened.push(socket);
        return socket;
      },
    });
    const connection = pairedConnection(deps, pairing);
    const pending = connection.fetch(`${connection.origin}/rpc/health`);
    connection.close();
    gate.resolve();
    await expect(pending).rejects.toBeInstanceOf(RelayUnreachableError);
    await vi.waitFor(() => expect(opened[0]?.readyState).toBe(3));
  });

  it("reports a refused socket that is not a 404 as unreachable", async () => {
    const pairing = await stored();
    const connection = pairedConnection(
      world.deps({
        connect: async () => {
          throw new RelayHttpError(429);
        },
      }),
      pairing,
    );
    open.push(connection);
    await expect(connection.fetch(`${connection.origin}/rpc/health`)).rejects.toMatchObject({
      reason: "relay answered 429",
    });
    const failing = pairedConnection(
      world.deps({
        connect: async () => {
          throw "down";
        },
      }),
      pairing,
    );
    open.push(failing);
    await expect(failing.fetch(`${failing.origin}/rpc/health`)).rejects.toMatchObject({
      reason: "down",
    });
  });
});
