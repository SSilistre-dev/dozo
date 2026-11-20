import { RELAY_PAIRING_TTL_MS } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayKeyPair } from "./dozo-relay-channel.js";
import {
  encodeRelayBytes,
  openAppChannel,
  parseRelayPairingOffer,
  relayAppToken,
  relayPairingSecrets,
  relayVerifier,
  webRelayCrypto,
} from "./dozo-relay-channel.js";
import type { RelayHostChannel, RelayHostEvent, RelayHostStore } from "./dozo-relay-host.js";
import {
  listRelayChannels,
  pairRelayHost,
  RelayHostError,
  RelayHttpError,
  revokeRelayChannel,
  runRelayHost,
} from "./dozo-relay-host.js";
import type { RelayWebSocket } from "./dozo-relay-ws.js";
import { wsDuplex } from "./dozo-relay-ws.js";

const crypto = webRelayCrypto();
const RELAY = "https://relay.test";
const CHANNEL = "Q2hhbm5lbC1pZC0xMjM0NQ";
const ORIGIN = "http://127.0.0.1:3000";

function memoryStore(initial: RelayHostChannel[] = []) {
  const channels = new Map(initial.map((entry) => [entry.channel, entry]));
  let key: RelayKeyPair | null = null;
  let changed: (() => void) | null = null;
  const store: RelayHostStore & {
    channels: typeof channels;
    change(): void;
    watching(): boolean;
  } = {
    channels,
    async hostKey(create) {
      key ??= await create();
      return key;
    },
    list: async () => [...channels.values()].map((entry) => structuredClone(entry)),
    async put(entry) {
      channels.set(entry.channel, structuredClone(entry));
    },
    async remove(channel) {
      channels.delete(channel);
    },
    watch(onChange) {
      changed = onChange;
      return () => {
        changed = null;
      };
    },
    change: () => changed?.(),
    watching: () => changed !== null,
  };
  return store;
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const socket = {
    binaryType: "blob",
    readyState: 1,
    sent: [] as (string | Uint8Array)[],
    send(data: string | Uint8Array) {
      socket.sent.push(data);
    },
    close(code?: number, reason?: string) {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      queueMicrotask(() => socket.emit("close", { code, reason }));
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    emit(type: string, event: Parameters<Listener>[0]) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
  return socket;
}

function response(status: number, body?: unknown, headers?: Record<string, string>) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

async function paired(overrides: Partial<RelayHostChannel> = {}): Promise<RelayHostChannel> {
  const app = await crypto.generateKeyPair();
  return {
    channel: CHANNEL,
    relay: RELAY,
    hostToken: "host-token",
    createdAt: 1,
    pairing: null,
    app: {
      key: encodeRelayBytes(app.publicKey),
      pairingKey: encodeRelayBytes(crypto.randomBytes(32)),
      verifierSet: true,
      pairedAt: 2,
    },
    ...overrides,
  };
}

function start(options: {
  store: RelayHostStore;
  connect: (url: string, token: string, signal: AbortSignal) => Promise<RelayWebSocket>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const events: RelayHostEvent[] = [];
  const controller = new AbortController();
  const done = runRelayHost({
    crypto,
    origin: ORIGIN,
    random: () => 0,
    fetch: options.fetch ?? (async () => response(204)),
    ...options,
    onEvent: (event) => events.push(event),
    signal: controller.signal,
  });
  return { events, stop: () => controller.abort(), done };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pairRelayHost", () => {
  it("registers verifiers only and returns an offer the phone accepts", async () => {
    const store = memoryStore();
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return response(201, { channel: CHANNEL });
    }) as unknown as typeof globalThis.fetch;
    const result = await pairRelayHost({
      store,
      crypto,
      fetch,
      relay: `${RELAY}/`,
      now: () => 1000,
    });

    expect(requests[0]?.url).toBe(`${RELAY}/v1/channels`);
    expect(requests[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.pairExpiresAt).toBe(1000 + RELAY_PAIRING_TTL_MS);

    const offer = parseRelayPairingOffer(result.offer, 1000);
    expect(offer).toMatchObject({ channel: CHANNEL, relay: RELAY, expiresAt: result.expiresAt });
    const secrets = await relayPairingSecrets(crypto, decode(offer.secret));
    expect(body.pairVerifier).toBe(await relayVerifier(crypto, secrets.token));

    const stored = store.channels.get(CHANNEL);
    expect(stored?.pairing?.psk).toBe(encodeRelayBytes(secrets.psk));
    expect(body.hostVerifier).toBe(await relayVerifier(crypto, stored?.hostToken ?? ""));
    expect(JSON.stringify(stored)).not.toContain(offer.secret);
    expect(result).toMatchObject({ channel: CHANNEL, relay: RELAY });
  });

  it("refuses a relay that is not https, unless it is on this computer", async () => {
    const store = memoryStore();
    const fetch = vi.fn(async () =>
      response(201, { channel: CHANNEL }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      pairRelayHost({ store, crypto, fetch, relay: "http://relay.test" }),
    ).rejects.toBeInstanceOf(RelayHostError);
    await expect(pairRelayHost({ store, crypto, fetch, relay: "nope" })).rejects.toThrow(
      "relay address must be https",
    );
    await pairRelayHost({ store, crypto, fetch, relay: "http://127.0.0.1:8787" });
    expect(store.channels.get(CHANNEL)?.relay).toBe("http://127.0.0.1:8787");
  });

  it("refuses a channel id it already holds, so a relay cannot overwrite a pairing", async () => {
    const store = memoryStore([await paired({ channel: CHANNEL.toLowerCase() })]);
    const fetch = vi.fn(async () =>
      response(201, { channel: CHANNEL }),
    ) as unknown as typeof globalThis.fetch;
    await expect(pairRelayHost({ store, crypto, fetch, relay: RELAY })).rejects.toThrow(
      "relay returned a channel that is already paired",
    );
  });

  it("asks again after a busy relay and fails on a bad answer", async () => {
    const store = memoryStore();
    const answers = [response(503), response(201, { channel: "bad" })];
    const fetch = vi.fn(async () => answers.shift()) as unknown as typeof globalThis.fetch;
    await expect(pairRelayHost({ store, crypto, fetch, relay: RELAY })).rejects.toThrow(
      "relay answered with an unexpected body",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const refusing = vi.fn(async () => response(400)) as unknown as typeof globalThis.fetch;
    const error = await pairRelayHost({ store, crypto, fetch: refusing, relay: RELAY }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RelayHttpError);
    expect((error as RelayHttpError).status).toBe(400);
    expect(refusing).toHaveBeenCalledTimes(1);
  });
});

describe("listRelayChannels", () => {
  it("shows each channel's state without its secrets", async () => {
    const done = await paired();
    const waiting: RelayHostChannel = {
      ...done,
      channel: "V2FpdGluZy1jaGFubmVsLTE",
      app: null,
      pairing: { psk: "secret-psk", expiresAt: 99 },
    };
    const summary = await listRelayChannels(memoryStore([done, waiting]));
    expect(summary).toEqual([
      {
        channel: CHANNEL,
        relay: RELAY,
        state: "paired",
        appKey: done.app?.key,
        pairedAt: 2,
      },
      { channel: waiting.channel, relay: RELAY, state: "pairing", expiresAt: 99 },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/secret-psk|host-token|pairingKey/);
  });
});

describe("revokeRelayChannel", () => {
  it("deletes the channel on the relay and forgets it", async () => {
    const store = memoryStore([await paired()]);
    const fetch = vi.fn(async () => response(204)) as unknown as typeof globalThis.fetch;
    expect(await revokeRelayChannel({ store, crypto, fetch, channel: CHANNEL })).toEqual({
      relay: "deleted",
    });
    expect(fetch).toHaveBeenCalledWith(
      `${RELAY}/v1/channels/${CHANNEL}`,
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer host-token" },
      }),
    );
    expect(store.channels.size).toBe(0);
  });

  it("forgets the channel even when the relay cannot be reached or already forgot it", async () => {
    const store = memoryStore([await paired()]);
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const result = await revokeRelayChannel({
      store,
      crypto,
      fetch,
      channel: CHANNEL,
      attempts: 2,
    });
    expect(result).toEqual({ relay: "unreachable" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.channels.size).toBe(0);

    const gone = memoryStore([await paired()]);
    const notFound = vi.fn(async () => response(404)) as unknown as typeof globalThis.fetch;
    expect(
      await revokeRelayChannel({ store: gone, crypto, fetch: notFound, channel: CHANNEL }),
    ).toEqual({ relay: "deleted" });
  });

  it("names a channel it does not hold", async () => {
    await expect(
      revokeRelayChannel({ store: memoryStore(), crypto, channel: CHANNEL }),
    ).rejects.toThrow("no such channel");
  });
});

describe("runRelayHost", () => {
  it("forgets a channel the relay no longer knows", async () => {
    const store = memoryStore([await paired()]);
    const connect = vi.fn(async () => {
      throw new RelayHttpError(404);
    });
    const host = start({ store, connect });
    await vi.waitFor(() => expect(store.channels.size).toBe(0));
    expect(host.events).toContainEqual({ event: "revoked", channel: CHANNEL });
    expect(connect).toHaveBeenCalledWith(
      `wss://relay.test/v1/channels/${CHANNEL}/host`,
      "host-token",
      expect.any(AbortSignal),
    );
    host.stop();
    await host.done;
  });

  it("waits as long as the relay asks before connecting again", async () => {
    const store = memoryStore([await paired()]);
    const socket = fakeSocket();
    const answers: (() => Promise<RelayWebSocket>)[] = [
      async () => {
        throw new RelayHttpError(429, 400);
      },
      async () => socket,
    ];
    const connect = vi.fn(async () => (answers.shift() as () => Promise<RelayWebSocket>)());
    const host = start({ store, connect });
    await vi.waitFor(
      () => expect(host.events).toContainEqual({ event: "connected", channel: CHANNEL }),
      { timeout: 3000 },
    );
    const disconnected = host.events.find((event) => event.event === "disconnected");
    expect(disconnected).toMatchObject({ channel: CHANNEL, retryInMs: 400 });

    socket.close(1012, "restart");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(host.events).toContainEqual({
      event: "disconnected",
      channel: CHANNEL,
      reason: "relay socket closed (1012 restart)",
      retryInMs: 0,
    });
    host.stop();
    await host.done;
  });

  it("sets the phone's verifier on the relay before connecting when that never finished", async () => {
    const entry = await paired();
    if (entry.app) entry.app.verifierSet = false;
    const store = memoryStore([entry]);
    const calls: { url: string; init?: RequestInit }[] = [];
    const answers = [response(500), response(204)];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return answers.shift() ?? response(204);
    }) as unknown as typeof globalThis.fetch;
    const connect = vi.fn(async () => fakeSocket());
    const host = start({ store, connect, fetch });
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(`${RELAY}/v1/channels/${CHANNEL}/app`);
    expect(calls[1]?.init?.method).toBe("PUT");
    const token = await relayAppToken(crypto, decode(entry.app?.pairingKey ?? ""));
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      appVerifier: await relayVerifier(crypto, token),
    });
    expect(store.channels.get(CHANNEL)?.app?.verifierSet).toBe(true);
    host.stop();
    await host.done;
  });

  it("follows the store: starts new channels and drops removed ones", async () => {
    const store = memoryStore();
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const connect = vi.fn(async () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    });
    const host = start({ store, connect });
    await vi.waitFor(() => expect(store.watching()).toBe(true));
    await store.put(await paired());
    store.change();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await store.remove(CHANNEL);
    store.change();
    await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(3));
    expect(host.events.filter((event) => event.event === "disconnected")).toHaveLength(0);
    host.stop();
    await host.done;
    expect(store.watching()).toBe(false);
  });

  it("drops an offer nobody used once it expires", async () => {
    let now = 1000;
    const offer: RelayHostChannel = {
      ...(await paired()),
      app: null,
      pairing: { psk: encodeRelayBytes(crypto.randomBytes(32)), expiresAt: 1050 },
    };
    const store = memoryStore([offer]);
    const socket = fakeSocket();
    const host = start({ store, connect: async () => socket, now: () => now });
    await vi.waitFor(() =>
      expect(host.events).toContainEqual({ event: "connected", channel: CHANNEL }),
    );
    now = 1100;
    await vi.waitFor(() => expect(store.channels.size).toBe(0));
    expect(host.events).toContainEqual({ event: "expired", channel: CHANNEL });
    expect(socket.readyState).toBe(3);
    host.stop();
    await host.done;
  });

  it("refuses a phone that is not the paired one and reports the other end coming and going", async () => {
    const store = memoryStore([await paired()]);
    const socket = fakeSocket();
    const host = start({ store, connect: async () => socket });
    await vi.waitFor(() =>
      expect(host.events).toContainEqual({ event: "connected", channel: CHANNEL }),
    );
    socket.emit("message", { data: JSON.stringify({ type: "peer", present: true }) });

    const stranger = await crypto.generateKeyPair();
    const hostKey = await store.hostKey(() => crypto.generateKeyPair());
    const appSide = fakeSocket();
    wsDuplex(appSide, {
      role: "app",
      onSession: (transport) => {
        void openAppChannel({
          crypto,
          transport,
          channel: CHANNEL,
          psk: crypto.randomBytes(32),
          appKey: stranger,
          hostKey: hostKey.publicKey,
        }).catch(() => undefined);
      },
    });
    const sendHello = appSide.send.bind(appSide);
    appSide.send = (data) => {
      sendHello(data);
      if (typeof data !== "string")
        queueMicrotask(() => socket.emit("message", { data: data.slice().buffer }));
    };
    appSide.emit("message", { data: JSON.stringify({ type: "peer", present: true }) });
    await vi.waitFor(() =>
      expect(host.events).toContainEqual({
        event: "refused",
        channel: CHANNEL,
        reason: "not the paired app",
      }),
    );
    socket.emit("message", { data: JSON.stringify({ type: "peer", present: false }) });
    expect(host.events).toContainEqual({ event: "peer", channel: CHANNEL, present: true });
    expect(host.events).toContainEqual({ event: "peer", channel: CHANNEL, present: false });
    host.stop();
    await host.done;
    expect(socket.readyState).toBe(3);
  });

  it("refuses a session on a channel whose offer expired before anyone paired", async () => {
    const offer: RelayHostChannel = {
      ...(await paired()),
      app: null,
      pairing: { psk: encodeRelayBytes(crypto.randomBytes(32)), expiresAt: 5000 },
    };
    const store = memoryStore([offer]);
    const socket = fakeSocket();
    let now = 1000;
    const host = start({ store, connect: async () => socket, now: () => now });
    await vi.waitFor(() =>
      expect(host.events).toContainEqual({ event: "connected", channel: CHANNEL }),
    );
    now = 6000;
    socket.emit("message", { data: new Uint8Array(81).fill(1).buffer });
    expect(host.events).toContainEqual({
      event: "refused",
      channel: CHANNEL,
      reason: "pairing offer expired",
    });
    host.stop();
    await host.done;
  });

  it("reports a store that fails and keeps trying", async () => {
    const store = memoryStore([await paired()]);
    const list = store.list;
    let failures = 1;
    store.list = async () => {
      if (failures-- > 0) throw new Error("disk unavailable");
      return list();
    };
    const connect = vi.fn(async () => fakeSocket());
    const host = start({ store, connect });
    await vi.waitFor(() => expect(connect).toHaveBeenCalled(), { timeout: 3000 });
    expect(host.events).toContainEqual({ event: "error", reason: "disk unavailable" });
    host.stop();
    await host.done;
  });

  it("stops at once when asked before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    await runRelayHost({
      store: memoryStore([await paired()]),
      crypto,
      origin: ORIGIN,
      connect: async () => {
        throw new Error("not called");
      },
      onEvent: () => undefined,
      signal: controller.signal,
    });
  });
});

function decode(text: string) {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );
}
