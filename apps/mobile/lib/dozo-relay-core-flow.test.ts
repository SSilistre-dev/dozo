import { createHash, randomBytes } from "node:crypto";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { RelayWebSocket } from "@rakazo/core";
import { decodeRelayBytes, relayAppToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_SESSION, relayWorld } from "./dozo-relay.test-support";
import type { RelayDeps, RelayPairing, RelayPairingStore } from "./dozo-relay-connection";
import {
  pairedConnection,
  pairRelay,
  RelayUnreachableError,
  readPairingOffer,
} from "./dozo-relay-connection";
import {
  adoptRelayConnection,
  installRelayFetch,
  isRelayComputerOffline,
  isRelayGone,
  resetRelayConnections,
  subscribeRelayState,
} from "./dozo-relay-fetch";

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("expo-crypto", () => ({
  getRandomValues: (array: Uint8Array) => {
    array.set(randomBytes(array.length));
    return array;
  },
}));

/**
 * The chat's core flow from the phone to the user's own computer over a real relay process on a
 * loopback port: the phone's own connection and `fetch`, the computer's agent, and a stand-in for
 * the local server's chat requests (`chatRoutes` in the test support).
 */

const SECRET = "a private message the relay must never read";

let world: Awaited<ReturnType<typeof relayWorld>>;

beforeEach(async () => {
  resetRelayConnections();
  world = await relayWorld();
  world.startHost();
});

afterEach(async () => {
  resetRelayConnections();
  await world.close();
});

function memory(pairing: RelayPairing): RelayPairingStore & { cleared: boolean } {
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

/** A phone paired with the computer, using it as its server as the app does. */
async function phone(deps: Partial<RelayDeps> = {}) {
  const { connection, pairing } = await pairRelay(
    readPairingOffer(await world.offer(), Date.now()),
    world.deps(deps),
  );
  await vi.waitFor(() =>
    expect(world.store.channels.get(pairing.channel)?.app?.verifierSet).toBe(true),
  );
  const store = memory(pairing);
  const target = { fetch: (() => Promise.reject(new Error("not a computer"))) as typeof fetch };
  installRelayFetch(target, store, world.deps(deps));
  adoptRelayConnection(connection, store);
  const { origin } = connection;
  const post = (path: string, body: unknown = {}) =>
    target.fetch(`${origin}/rpc/chat/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CHAT_SESSION}` },
      body: JSON.stringify({ json: body }),
    });
  const rpc = async <T>(path: string, body?: unknown) => {
    const response = await post(path, body);
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: T }).json;
  };
  return {
    origin,
    pairing,
    store,
    connection,
    rpc,
    list: () => rpc<{ messages: { text: string }[] }>("list").then((it) => it.messages),
    /** The live stream: each `next` is the next signal, or a rejection once it ended. */
    async subscribe() {
      const response = await post("subscribe");
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let buffered = "";
      return {
        async next() {
          while (!buffered.includes("\n\n")) {
            const { done, value } = await reader.read();
            if (done) throw new Error("the live stream ended");
            buffered += new TextDecoder().decode(value);
          }
          const end = buffered.indexOf("\n\n");
          const event = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          return event;
        },
        cancel: () => reader.cancel(),
      };
    },
  };
}

const SIGNAL = 'data: {"type":"chats"}';

describe("the chat over the relay", { timeout: 60_000 }, () => {
  it("reads the chats, sends a large attachment and hears changes live, the relay seeing ciphertext only", async () => {
    const me = await phone();
    const live = await me.subscribe();
    // Every (re)connect signals once: the client reads then.
    expect(await live.next()).toBe(SIGNAL);
    expect(await me.list()).toEqual([]);

    const photo = randomBytes(ATTACHMENT_MAX_BYTES);
    const sent = await me.rpc<{ attachments: { sha256: string }[] }>("send", {
      text: SECRET,
      attachments: [{ name: "holiday.jpg", contentBase64: photo.toString("base64") }],
    });
    expect(sent.attachments[0]?.sha256).toBe(createHash("sha256").update(photo).digest("hex"));
    expect(await live.next()).toBe(SIGNAL);
    // The computer's answer arrives as a signal on the open stream, then a read.
    world.local.chat.reply("the bot's answer");
    expect(await live.next()).toBe(SIGNAL);
    expect((await me.list()).map((message) => message.text)).toEqual([SECRET, "the bot's answer"]);

    const wire = world.wire();
    // Everything crossed the relay, sealed.
    expect(wire.length).toBeGreaterThan(photo.length);
    for (const plain of [
      SECRET,
      CHAT_SESSION,
      "holiday.jpg",
      "/rpc/chat/",
      photo.subarray(0, 48).toString("base64"),
    ]) {
      expect(wire.includes(Buffer.from(plain))).toBe(false);
    }
    expect(wire.includes(photo.subarray(4096, 4160))).toBe(false);
    // The relay keeps verifiers, never a key or the pairing's secrets; the computer's log
    // carries no content or session.
    const kept = JSON.stringify(
      [...world.relayState.values()].map(({ sockets: _sockets, ...entry }) => entry),
    );
    const logged = JSON.stringify(world.events);
    for (const secret of [me.pairing.pairingKey, me.pairing.appPrivateKey, CHAT_SESSION, SECRET]) {
      expect(kept).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    await live.cancel();
  });

  it("reconnects after the relay restarts and catches up on what changed meanwhile", async () => {
    const me = await phone();
    const live = await me.subscribe();
    expect(await live.next()).toBe(SIGNAL);
    await world.restartRelay();
    await expect(live.next()).rejects.toThrow();
    world.local.chat.reply("while the phone was cut off");
    // The client opens its stream again; the stream's first signal is the catch-up.
    const again = await vi.waitFor(() => me.subscribe());
    expect(await again.next()).toBe(SIGNAL);
    expect((await me.list()).map((message) => message.text)).toEqual([
      "while the phone was cut off",
    ]);
    await again.cancel();
  });

  it("says the computer is offline at once, fails like an unreachable server, and recovers", async () => {
    const me = await phone({ sessionWaitMs: 300 });
    const live = await me.subscribe();
    await live.next();
    const changes = vi.fn();
    const unsubscribe = subscribeRelayState(changes);
    expect(isRelayComputerOffline(me.origin)).toBe(false);

    await world.stopHost();
    await expect(live.next()).rejects.toThrow();
    await vi.waitFor(() => expect(isRelayComputerOffline(me.origin)).toBe(true));
    expect(changes).toHaveBeenCalled();
    await expect(me.list()).rejects.toBeInstanceOf(RelayUnreachableError);

    world.startHost();
    await vi.waitFor(() => expect(isRelayComputerOffline(me.origin)).toBe(false));
    expect(await me.list()).toEqual([]);
    unsubscribe();
  });

  it("drops the phone at once when the computer removes it, its live stream included, even right after pairing", async () => {
    const me = await phone();
    // Inside the grace a 404 gets after pairing: a deleted channel's close needs none.
    if (Date.now() - me.pairing.pairedAt >= 2 * 60_000) {
      throw new Error("the pairing is past the grace a 404 gets");
    }
    const live = await me.subscribe();
    await live.next();
    expect(await world.revoke(me.pairing.channel)).toMatchObject({ relay: "deleted" });
    await expect(live.next()).rejects.toThrow();
    // Without another request: the relay's close says the channel is gone.
    await vi.waitFor(() => expect(isRelayGone(me.origin)).toBe(true));
    await vi.waitFor(() => expect(me.store.cleared).toBe(true));
    await expect(me.list()).rejects.toBeInstanceOf(RelayUnreachableError);
  });

  it("keeps two phones apart: each its own channel, one removed while the other goes on", async () => {
    const first = await phone();
    resetRelayConnections();
    const second = await phone();
    expect(second.pairing.channel).not.toBe(first.pairing.channel);
    const live = await second.subscribe();
    await live.next();

    // One phone's token opens no other phone's channel.
    const crypto = world.deps().crypto;
    const token = await relayAppToken(crypto, decodeRelayBytes(first.pairing.pairingKey));
    await expect(
      world
        .deps()
        .connect(
          `${world.relayUrl.replace(/^http/, "ws")}/v1/channels/${second.pairing.channel}/app`,
          token,
          new AbortController().signal,
        ),
    ).rejects.toMatchObject({ status: 404 });

    // Someone holding the first phone's keys cannot pass for the second on its channel.
    const impostor = pairedConnection(world.deps({ sessionWaitMs: 300 }), {
      ...second.pairing,
      appPublicKey: first.pairing.appPublicKey,
      appPrivateKey: first.pairing.appPrivateKey,
      pairingKey: first.pairing.pairingKey,
    });
    await expect(impostor.fetch(`${impostor.origin}/rpc/health`)).rejects.toBeInstanceOf(
      RelayUnreachableError,
    );
    impostor.close();

    await world.revoke(first.pairing.channel);
    world.local.chat.reply("for the second phone");
    expect(await live.next()).toBe(SIGNAL);
    expect((await second.list()).map((message) => message.text)).toEqual(["for the second phone"]);
    await live.cancel();
  });

  it("sends nothing twice when the relay replays a record, and the phone gets a new session", async () => {
    const outgoing: Uint8Array[] = [];
    let socket: RelayWebSocket | null = null;
    const connect: RelayDeps["connect"] = async (url, token, signal) => {
      const opened = await world.deps().connect(url, token, signal);
      const send = opened.send.bind(opened);
      opened.send = (data) => {
        if (typeof data !== "string") outgoing.push(data.slice());
        send(data);
      };
      socket = opened;
      return opened;
    };
    const me = await phone({ connect });
    await me.list();
    const before = outgoing.length;
    await me.rpc("send", { text: "once", attachments: [] });
    const records = outgoing.slice(before);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) (socket as RelayWebSocket | null)?.send(record);
    // The computer drops that session and the phone starts another; the message stays one.
    await vi.waitFor(async () => expect(await me.list()).toHaveLength(1), { timeout: 10_000 });
    expect(world.local.chat.messages.map((message) => message.text)).toEqual(["once"]);
  });
});
