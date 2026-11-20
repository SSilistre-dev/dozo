import { RELAY_MAX_MESSAGE_BYTES, RELAY_PAIRING_TTL_MS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { deferred, flush } from "./async.test-support.js";
import { containsBytes, relayPipe } from "./dozo-relay.test-support.js";
import type { RelayChannel, RelayCrypto } from "./dozo-relay-channel.js";
import {
  acceptHostChannel,
  decodeRelayBytes,
  encodeRelayBytes,
  encodeRelayPairingOffer,
  openAppChannel,
  parseRelayPairingOffer,
  relayAppToken,
  relayPairingSecrets,
  relayVerifier,
  webRelayCrypto,
} from "./dozo-relay-channel.js";

const crypto = webRelayCrypto();
const CHANNEL = encodeRelayBytes(new Uint8Array(16).fill(7));
const text = (value: string) => new TextEncoder().encode(value);

async function keys() {
  const secret = crypto.randomBytes(32);
  const { psk } = await relayPairingSecrets(crypto, secret);
  return { secret, psk, host: await crypto.generateKeyPair(), app: await crypto.generateKeyPair() };
}

function collect(channel: RelayChannel) {
  const received: string[] = [];
  const closed = vi.fn();
  channel.attach({ receive: (data) => received.push(new TextDecoder().decode(data)), closed });
  return { received, closed };
}

async function pair(pipe = relayPipe(), given?: Awaited<ReturnType<typeof keys>>) {
  const k = given ?? (await keys());
  const [host, app] = await Promise.all([
    acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    }),
    openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    }),
  ]);
  return { pipe, host, app, k };
}

describe("relay channel", () => {
  it("pairs: both ends agree on the pairing key and learn each other's key", async () => {
    const { host, app, k } = await pair();
    expect(host.peerKey).toEqual(k.app.publicKey);
    expect(app.peerKey).toEqual(k.host.publicKey);
    expect(host.pairingKey).toEqual(app.pairingKey);
    expect(host.pairingKey).toHaveLength(32);
  });

  it("carries messages both ways, in order", async () => {
    const { host, app } = await pair();
    const atHost = collect(host);
    const atApp = collect(app);
    app.send(text("one"));
    app.send(text("two"));
    host.send(text("back"));
    await vi.waitFor(() => expect(atHost.received).toEqual(["one", "two"]));
    await vi.waitFor(() => expect(atApp.received).toEqual(["back"]));
  });

  it("holds messages that arrive before a receiver is attached", async () => {
    // The host's second open is the record's (the first checks the hello).
    let opens = 0;
    const recordOpened = deferred();
    const watched: RelayCrypto = {
      ...crypto,
      aead: async (key) => {
        const aead = await crypto.aead(key);
        const open: typeof aead.open = (...args) =>
          aead.open(...args).finally(() => {
            opens += 1;
            if (opens === 2) recordOpened.resolve();
          });
        return { ...aead, open };
      },
    };
    const k = await keys();
    const pipe = relayPipe();
    const [host, app] = await Promise.all([
      acceptHostChannel({
        crypto: watched,
        transport: pipe.host,
        channel: CHANNEL,
        psk: k.psk,
        hostKey: k.host,
        appKey: null,
      }),
      openAppChannel({
        crypto,
        transport: pipe.app,
        channel: CHANNEL,
        psk: k.psk,
        appKey: k.app,
        hostKey: k.host.publicKey,
      }),
    ]);
    app.send(text("early"));
    await recordOpened.promise;
    await flush();
    const atHost = collect(host);
    await vi.waitFor(() => expect(atHost.received).toEqual(["early"]));
  });

  it("accepts a hello that arrived before the host started listening", async () => {
    const k = await keys();
    const pipe = relayPipe();
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await vi.waitFor(() => expect(pipe.log).toHaveLength(1));
    await flush();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    await expect(Promise.all([host, app])).resolves.toHaveLength(2);
  });

  it("fails at once on a relay connection that closed while it was attached", async () => {
    const k = await keys();
    const closed = {
      send: () => undefined,
      close: () => undefined,
      attach: (receiver: { closed(error: Error): void }) => receiver.closed(new Error("gone")),
    };
    await expect(
      openAppChannel({
        crypto,
        transport: closed,
        channel: CHANNEL,
        psk: k.psk,
        appKey: k.app,
        hostKey: k.host.publicKey,
      }),
    ).rejects.toThrow("relay connection closed: gone");
  });

  it("closes when its receiver throws", async () => {
    const { host, app } = await pair();
    const closed = vi.fn();
    host.attach({
      receive: () => {
        throw new Error("bad state");
      },
      closed,
    });
    app.send(text("boom"));
    await vi.waitFor(() =>
      expect(String(closed.mock.calls[0]?.[0])).toContain("receiver failed: bad state"),
    );
  });

  it("sends nothing sealed after the channel closed", async () => {
    const { pipe, app } = await pair();
    const before = pipe.log.length;
    app.send(text("too late"));
    app.close("leaving");
    await flush();
    expect(pipe.log).toHaveLength(before);
  });

  it("lets the relay see only ciphertext", async () => {
    const { pipe, host, app, k } = await pair();
    const atHost = collect(host);
    const secret = "GET /api/bots?token=placeholder-session-token";
    app.send(text(secret));
    await vi.waitFor(() => expect(atHost.received).toEqual([secret]));
    for (const { data } of pipe.log) {
      expect(containsBytes(data, text("placeholder-session-token"))).toBe(false);
      expect(containsBytes(data, k.secret)).toBe(false);
      expect(containsBytes(data, k.psk)).toBe(false);
      expect(containsBytes(data, host.pairingKey)).toBe(false);
    }
    // The relay sees the two public keys of the handshake and nothing it could open.
    expect(pipe.log[0]?.data).toHaveLength(81);
    expect(pipe.log[1]?.data).toHaveLength(49);
  });

  it("reconnects with the pairing key and fresh session keys", async () => {
    const first = await pair();
    const stored = { ...first.k, psk: first.host.pairingKey };
    const sealed: Uint8Array[] = [];
    for (let round = 0; round < 2; round += 1) {
      const pipe = relayPipe();
      const [host, app] = await Promise.all([
        acceptHostChannel({
          crypto,
          transport: pipe.host,
          channel: CHANNEL,
          psk: stored.psk,
          hostKey: stored.host,
          appKey: stored.app.publicKey,
        }),
        openAppChannel({
          crypto,
          transport: pipe.app,
          channel: CHANNEL,
          psk: stored.psk,
          appKey: stored.app,
          hostKey: stored.host.publicKey,
        }),
      ]);
      const atHost = collect(host);
      app.send(text("same words"));
      await vi.waitFor(() => expect(atHost.received).toEqual(["same words"]));
      sealed.push(pipe.log.at(-1)?.data ?? new Uint8Array(0));
    }
    expect(sealed[0]).toHaveLength(sealed[1]?.length ?? 0);
    expect(sealed[0]).not.toEqual(sealed[1]);
  });

  it("refuses a phone that does not know the pairing secret", async () => {
    const k = await keys();
    const pipe = relayPipe();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: crypto.randomBytes(32),
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(host).rejects.toThrow("handshake failed authentication");
    await expect(app).rejects.toThrow("relay connection closed");
  });

  it("refuses a host that does not hold its private key", async () => {
    const k = await keys();
    const impostor = await crypto.generateKeyPair();
    const pipe = relayPipe();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: { publicKey: k.host.publicKey, privateKey: impostor.privateKey },
      appKey: null,
    });
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(Promise.allSettled([host, app])).resolves.toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
  });

  it("refuses another phone once paired", async () => {
    const k = await keys();
    const stranger = await crypto.generateKeyPair();
    const pipe = relayPipe();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: k.app.publicKey,
    });
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: stranger,
      hostKey: k.host.publicKey,
    });
    await expect(host).rejects.toThrow("not the paired app");
    await expect(app).rejects.toThrow();
  });

  it("refuses a tampered welcome and a message that is not a handshake", async () => {
    const k = await keys();
    const pipe = relayPipe();
    pipe.tap = (from, data) => {
      if (from === "host") data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
      return [data];
    };
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(app).rejects.toThrow("handshake failed authentication");
    await Promise.allSettled([host]);

    const garbage = relayPipe();
    garbage.tap = () => [new Uint8Array([3, 0, 0])];
    const host2 = acceptHostChannel({
      crypto,
      transport: garbage.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    const app2 = openAppChannel({
      crypto,
      transport: garbage.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(host2).rejects.toThrow("expected a hello");
    await expect(app2).rejects.toThrow();

    const short = relayPipe();
    short.tap = (from, data) => (from === "host" ? [data.subarray(0, 10)] : [data]);
    const host3 = acceptHostChannel({
      crypto,
      transport: short.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    const app3 = openAppChannel({
      crypto,
      transport: short.app,
      channel: CHANNEL,
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(app3).rejects.toThrow("expected a welcome");
    await Promise.allSettled([host3]);
  });

  it("binds the session to its channel id", async () => {
    const k = await keys();
    const pipe = relayPipe();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    const app = openAppChannel({
      crypto,
      transport: pipe.app,
      channel: "other",
      psk: k.psk,
      appKey: k.app,
      hostKey: k.host.publicKey,
    });
    await expect(host).rejects.toThrow("handshake failed authentication");
    await expect(app).rejects.toThrow();
  });

  it.each([
    [
      "changed",
      (data: Uint8Array) => [
        Uint8Array.from(data, (byte, index) => (index === data.length - 1 ? byte ^ 1 : byte)),
      ],
    ],
    ["replayed", (data: Uint8Array) => [data, data]],
    ["dropped", (data: Uint8Array) => (data[8] === 1 ? [] : [data])],
    ["truncated", (data: Uint8Array) => [data.subarray(0, 20)]],
    ["oversized", () => [new Uint8Array(RELAY_MAX_MESSAGE_BYTES + 1).fill(3)]],
    [
      "of another type",
      (data: Uint8Array) => [Uint8Array.from(data, (byte, index) => (index === 0 ? 9 : byte))],
    ],
  ])("closes on a record that was %s", async (_, change) => {
    const { pipe, host, app } = await pair();
    const atHost = collect(host);
    pipe.tap = (from, data) => (from === "app" ? change(data) : [data]);
    app.send(text("first"));
    app.send(text("second"));
    await vi.waitFor(() => expect(atHost.closed).toHaveBeenCalled());
    expect(atHost.received).not.toContain("second");
    expect(String(atHost.closed.mock.calls[0]?.[0])).toMatch(
      /failed authentication|out of order or replayed|malformed record|record too large/,
    );
  });

  it("closes on records swapped in order", async () => {
    const { pipe, host, app } = await pair();
    const atHost = collect(host);
    let held: Uint8Array | null = null;
    pipe.tap = (from, data) => {
      if (from !== "app") return [data];
      if (!held) {
        held = data;
        return [];
      }
      return [data, held];
    };
    app.send(text("first"));
    app.send(text("second"));
    await vi.waitFor(() =>
      expect(String(atHost.closed.mock.calls[0]?.[0])).toContain("out of order or replayed"),
    );
    expect(atHost.received).toEqual([]);
  });

  it("refuses to seal more than one record can hold", async () => {
    const { app } = await pair();
    expect(() => app.send(new Uint8Array(RELAY_MAX_MESSAGE_BYTES))).toThrow("record too large");
  });

  it("closes both ends when the relay connection drops", async () => {
    const { pipe, host, app } = await pair();
    const atHost = collect(host);
    pipe.app.close("socket gone");
    await vi.waitFor(() => expect(atHost.closed).toHaveBeenCalled());
    const late = collect(app);
    expect(String(late.closed.mock.calls[0]?.[0])).toContain("socket gone");
    app.send(text("ignored"));
    host.close("again");
  });

  it("fails the handshake when the relay connection drops first", async () => {
    const k = await keys();
    const pipe = relayPipe();
    const host = acceptHostChannel({
      crypto,
      transport: pipe.host,
      channel: CHANNEL,
      psk: k.psk,
      hostKey: k.host,
      appKey: null,
    });
    pipe.app.close("socket gone");
    await expect(host).rejects.toThrow("relay connection closed: socket gone");
  });

  it("derives distinct relay tokens and their verifiers", async () => {
    const secret = new Uint8Array(32).fill(1);
    const pairing = await relayPairingSecrets(crypto, secret);
    expect(await relayPairingSecrets(crypto, secret)).toEqual(pairing);
    expect(pairing.token).not.toBe(encodeRelayBytes(pairing.psk));
    const appToken = await relayAppToken(crypto, pairing.psk);
    expect(appToken).not.toBe(pairing.token);
    const verifier = await relayVerifier(crypto, appToken);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).not.toBe(appToken);
  });

  it("encodes and checks a pairing offer", async () => {
    const offer = {
      v: 1 as const,
      relay: "https://relay.example/",
      channel: CHANNEL,
      hostKey: encodeRelayBytes((await crypto.generateKeyPair()).publicKey),
      secret: encodeRelayBytes(crypto.randomBytes(32)),
      expiresAt: 1_000 + RELAY_PAIRING_TTL_MS,
    };
    const encoded = encodeRelayPairingOffer(offer);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseRelayPairingOffer(encoded, 1_000)).toEqual(offer);
    expect(() => parseRelayPairingOffer(encoded, offer.expiresAt)).toThrow("pairing offer expired");
    expect(() => parseRelayPairingOffer("!!", 0)).toThrow("not a pairing offer");
    expect(() => parseRelayPairingOffer(encodeRelayBytes(text('{"v":2}')), 0)).toThrow(
      "not a pairing offer",
    );
    expect(() => encodeRelayPairingOffer({ ...offer, relay: "ftp://relay.example" })).toThrow();
    expect(() => encodeRelayPairingOffer({ ...offer, relay: "http://relay.example" })).toThrow();
    expect(encodeRelayPairingOffer({ ...offer, relay: "http://127.0.0.1:8787" })).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });

  it("round-trips bytes through base64url", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeRelayBytes(encodeRelayBytes(bytes))).toEqual(bytes);
  });
});
