import { randomBytes } from "node:crypto";
import { decodeRelayBytes, RelayHttpError, relayApprovalCode, webRelayCrypto } from "@rakazo/core";
import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relayWorld } from "./dozo-relay.test-support";
import type { RelayPairing, RelayPairingStore } from "./dozo-relay-connection";
import {
  pairRelay,
  RelayUnreachableError,
  readPairingOffer,
  relayOrigin,
} from "./dozo-relay-connection";
import {
  adoptRelayConnection,
  connectNativeRelaySocket,
  DEFAULT_RELAY,
  forgetRelayConnection,
  installRelayFetch,
  isRelayGone,
  keepOnlyRelayConnection,
  relayApprovalCodeOf,
  relayDeps,
  relayPairingStore,
  resetRelayConnections,
  subscribeRelayState,
  upgradeStatus,
} from "./dozo-relay-fetch";

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secure.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void secure.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => void secure.delete(key)),
}));
vi.mock("expo-crypto", () => ({
  getRandomValues: (array: Uint8Array) => {
    array.set(randomBytes(array.length));
    return array;
  },
}));

/** React Native's socket as the app sees it: a third argument with headers, and on* handlers. */
class FakeSocket {
  static last: FakeSocket;
  binaryType = "blob";
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: unknown,
    readonly options: { headers: Record<string, string> },
  ) {
    FakeSocket.last = this;
  }
  send() {}
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  secure.clear();
  resetRelayConnections();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelayConnections();
});

describe("connectNativeRelaySocket", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  const open = (signal = new AbortController().signal) =>
    connectNativeRelaySocket("wss://relay.example.invalid/v1/channels/c/app", "tok", signal);

  it("sends the token in the upgrade and hands over the open socket", async () => {
    const pending = open();
    const socket = FakeSocket.last;
    expect(socket.options.headers.Authorization).toBe("Bearer tok");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.onopen?.();
    expect(await pending).toBe(socket);
    expect(socket.onopen).toBeNull();
  });

  it("reports a refused upgrade with its status, as either platform words it", async () => {
    const ios = open();
    FakeSocket.last.onerror?.({ message: "Received bad response code from server: 404." });
    await expect(ios).rejects.toEqual(new RelayHttpError(404));
    const android = open();
    FakeSocket.last.onerror?.({ message: "Expected HTTP 101 response but was '429 Too Many'" });
    await expect(android).rejects.toMatchObject({ status: 429 });
    expect(FakeSocket.last.closed).toBe(true);
  });

  it("reports any other failure as unreachable", async () => {
    const failed = open();
    FakeSocket.last.onerror?.({});
    await expect(failed).rejects.toBeInstanceOf(RelayUnreachableError);
    const closed = open();
    FakeSocket.last.onclose?.({ reason: "" });
    await expect(closed).rejects.toMatchObject({ reason: "socket closed" });
    const named = open();
    FakeSocket.last.onclose?.({ reason: "going away" });
    await expect(named).rejects.toMatchObject({ reason: "going away" });
  });

  it("stops when aborted, before or while opening", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(open(controller.signal)).rejects.toThrow("stop");
    const later = new AbortController();
    const pending = open(later.signal);
    later.abort(new Error("later"));
    await expect(pending).rejects.toThrow("later");
  });

  it("reads statuses only from the messages that carry them", () => {
    expect(upgradeStatus("socket closed")).toBeNull();
    expect(upgradeStatus()).toBeNull();
  });
});

const KEY = "A".repeat(43);
const STORED: RelayPairing = {
  relay: "https://relay.example.invalid",
  channel: "B".repeat(22),
  hostKey: KEY,
  appPublicKey: KEY,
  appPrivateKey: KEY,
  pairingKey: KEY,
  originId: "ab".repeat(16),
  pairedAt: 1,
};

describe("the pairing store", () => {
  it("keeps the pairing in the secure store and forgets it", async () => {
    expect(await relayPairingStore.load()).toBeNull();
    await relayPairingStore.save(STORED);
    expect(await relayPairingStore.load()).toEqual(STORED);
    await relayPairingStore.clear();
    expect(await relayPairingStore.load()).toBeNull();
  });

  it("reads a stored value that is not a whole pairing as none", async () => {
    secure.set("dozo.relay_pairing", "{");
    expect(await relayPairingStore.load()).toBeNull();
    secure.set("dozo.relay_pairing", JSON.stringify({ channel: "c" }));
    expect(await relayPairingStore.load()).toBeNull();
    secure.set(
      "dozo.relay_pairing",
      JSON.stringify({ ...STORED, relay: "http://relay.example.com" }),
    );
    expect(await relayPairingStore.load()).toBeNull();
  });

  it("pairs through this build's relay unless told otherwise", () => {
    expect(DEFAULT_RELAY).toBe("https://relay.dozo.bot");
  });

  it("uses the system's random source", () => {
    expect(relayDeps.crypto.randomBytes(8)).toHaveLength(8);
  });
});

describe("installRelayFetch", () => {
  let world: Awaited<ReturnType<typeof relayWorld>>;
  beforeEach(async () => {
    world = await relayWorld();
  });
  afterEach(async () => {
    await world.close();
  });

  function memory(pairing: RelayPairing | null): RelayPairingStore & { cleared: boolean } {
    const store = {
      cleared: false,
      load: async () => pairing,
      save: async () => undefined,
      clear: async () => {
        store.cleared = true;
      },
    };
    return store;
  }

  it("leaves every other origin to the platform's fetch", async () => {
    const base = vi.fn(async () => new Response("direct"));
    const target = { fetch: base as unknown as typeof fetch };
    installRelayFetch(target, memory(null), world.deps());
    expect(await (await target.fetch("https://app.example.invalid/rpc/x")).text()).toBe("direct");
    expect(await (await target.fetch(new URL("https://app.example.invalid/"))).text()).toBe(
      "direct",
    );
    await target.fetch("not a url");
    expect(base).toHaveBeenCalledTimes(3);
  });

  it("fails like an unreachable server for a computer that is not paired", async () => {
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    installRelayFetch(target, memory(null), world.deps());
    await expect(target.fetch(`${relayOrigin("cd".repeat(16))}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
  });

  it("never sends a computer's name with a port, a user or plain http to the network", async () => {
    const base = vi.fn();
    const target = { fetch: base as unknown as typeof fetch };
    installRelayFetch(target, memory(null), world.deps());
    const host = `${"cd".repeat(16)}.computer.dozo.invalid`;
    for (const address of [
      `https://${host}:8443/`,
      `https://user:secret@${host}/`,
      `http://${host}/`,
      "https://short.computer.dozo.invalid/",
    ]) {
      await expect(target.fetch(address)).rejects.toBeInstanceOf(RelayUnreachableError);
    }
    expect(base).not.toHaveBeenCalled();
  });

  it("serves the stored pairing's origin through the relay, Request inputs included", async () => {
    world.startHost();
    const { connection, pairing } = await pairRelay(
      readPairingOffer(await world.offer(), Date.now()),
      world.deps(),
    );
    connection.close();
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    installRelayFetch(target, memory(pairing), world.deps());
    const origin = relayOrigin(pairing.originId);
    await vi.waitFor(async () =>
      expect((await target.fetch(`${origin}/rpc/health`)).ok).toBe(true),
    );
    const input = { url: `${origin}/echo`, method: "POST", body: null } as unknown as Request;
    expect((await target.fetch(input, { body: "x" })).ok).toBe(true);
    // An address in capitals is the same computer.
    expect(
      (await target.fetch(`${origin.toUpperCase().replace("HTTPS", "https")}/rpc/health`)).ok,
    ).toBe(true);
  });

  it("serves a freshly paired computer, keeps only the one in use, and forgets a removed one", async () => {
    world.startHost();
    const { connection, pairing } = await pairRelay(
      readPairingOffer(await world.offer(), Date.now()),
      world.deps(),
    );
    const store = memory(pairing);
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    installRelayFetch(target, store, world.deps());
    adoptRelayConnection(connection, store);
    expect((await target.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true);
    keepOnlyRelayConnection(connection.origin);
    expect((await target.fetch(`${connection.origin}/rpc/health`)).ok).toBe(true);
    const listener = vi.fn();
    const unsubscribe = subscribeRelayState(listener);
    connection.onGone?.();
    unsubscribe();
    // Once for the removal; the closed socket also says the computer's presence is unknown.
    expect(listener).toHaveBeenCalled();
    expect(isRelayGone(connection.origin)).toBe(true);
    await vi.waitFor(() => expect(store.cleared).toBe(true));
    await expect(target.fetch(`${connection.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    // Pairing it again brings it back.
    adoptRelayConnection(connection);
    expect(isRelayGone(connection.origin)).toBe(false);
    keepOnlyRelayConnection("https://other.example.invalid");
  });

  it("keeps a newer stored pairing when an older computer removes the phone", async () => {
    world.startHost();
    const { connection } = await pairRelay(
      readPairingOffer(await world.offer(), Date.now()),
      world.deps(),
    );
    const store = memory(STORED);
    adoptRelayConnection(connection, store);
    connection.onGone?.();
    await flush();
    expect(store.cleared).toBe(false);
  });

  it("gives the approval code of a paired computer, as the computer derives it", async () => {
    world.startHost();
    const { connection, pairing } = await pairRelay(
      readPairingOffer(await world.offer(), Date.now()),
      world.deps(),
    );
    connection.close();
    const code = await relayApprovalCodeOf(
      relayOrigin(pairing.originId),
      memory(pairing),
      world.deps(),
    );
    expect(code).toBe(
      await relayApprovalCode(webRelayCrypto(), decodeRelayBytes(pairing.pairingKey)),
    );
    expect(
      await relayApprovalCodeOf("https://other.example.invalid", memory(null), world.deps()),
    ).toBeNull();
  });

  it("ends a connection whose server switch failed", async () => {
    world.startHost();
    const { connection } = await pairRelay(
      readPairingOffer(await world.offer(), Date.now()),
      world.deps(),
    );
    const target = { fetch: vi.fn() as unknown as typeof fetch };
    installRelayFetch(target, memory(null), world.deps());
    adoptRelayConnection(connection);
    forgetRelayConnection(connection.origin);
    forgetRelayConnection(connection.origin);
    await expect(target.fetch(`${connection.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
  });
});
