import { deferred } from "@dozo/relay-core/async.test-support";
import type { RelayDuplex, RelayKeyPair, RelayReceiver } from "@dozo/relay-core/dozo-relay-channel";
import {
  acceptHostChannel,
  openAppChannel,
  relayAppToken,
  relayPairingSecrets,
  relayVerifier,
} from "@dozo/relay-core/dozo-relay-channel";
import { relayClient, serveRelay } from "@dozo/relay-core/dozo-relay-mux";
import { describe, expect, it } from "vitest";
import { call, peer, register, relayCrypto, upgrade } from "./support.js";

const ORIGIN = "http://127.0.0.1:3000";
const SECRET_PATH = "/api/notes/very-private-path";
const SECRET_BODY = "the plaintext the relay must never see";

/**
 * A relay socket as the ends' `RelayDuplex`: binary goes to the channel, the relay's `peer` text
 * resolves `present`, and every binary message is copied to `wire` (what crossed the relay).
 */
async function socketDuplex(response: Response, wire: Uint8Array[]) {
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) throw new Error(`connect answered ${response.status}`);
  let receiver: RelayReceiver | null = null;
  const early: Uint8Array[] = [];
  const present = deferred();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data === peer(true)) present.resolve();
      return;
    }
    const data = new Uint8Array(event.data as ArrayBuffer);
    wire.push(data);
    if (receiver) receiver.receive(data);
    else early.push(data);
  });
  ws.addEventListener("close", () => receiver?.closed(new Error("socket closed")));
  // Binary arrives as ArrayBuffer, as the ends ask for; the runtime default is Blob.
  ws.binaryType = "arraybuffer";
  ws.accept();
  const duplex: RelayDuplex = {
    send: (data) => {
      wire.push(data);
      ws.send(data);
    },
    close: (reason) => ws.close(1000, reason.slice(0, 100)),
    attach(next) {
      receiver = next;
      for (const data of early.splice(0)) next.receive(data);
    },
  };
  return { duplex, present: present.promise, ws };
}

async function session(
  channel: string,
  bearer: { host: string; app: string },
  keys: { psk: Uint8Array; host: RelayKeyPair; app: RelayKeyPair; pairedApp: Uint8Array | null },
  wire: Uint8Array[],
) {
  const host = await socketDuplex(await upgrade(channel, "host", bearer.host), wire);
  const app = await socketDuplex(await upgrade(channel, "app", bearer.app), wire);
  await Promise.all([host.present, app.present]);
  const [hostChannel, appChannel] = await Promise.all([
    acceptHostChannel({
      crypto: relayCrypto,
      transport: host.duplex,
      channel,
      psk: keys.psk,
      hostKey: keys.host,
      appKey: keys.pairedApp,
    }),
    openAppChannel({
      crypto: relayCrypto,
      transport: app.duplex,
      channel,
      psk: keys.psk,
      appKey: keys.app,
      hostKey: keys.host.publicKey,
    }),
  ]);
  const server = serveRelay(hostChannel, {
    origin: ORIGIN,
    forward: async (request) =>
      new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`, {
        headers: { "content-type": "text/plain" },
      }),
  });
  const client = relayClient(appChannel);
  return { hostChannel, appChannel, client, server, sockets: [host.ws, app.ws] };
}

function contains(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe("the real channel and multiplexer through the relay", () => {
  it("pairs, confirms, reconnects with the app token and only ever relays ciphertext", async () => {
    const secret = relayCrypto.randomBytes(32);
    const { psk, token: pairToken } = await relayPairingSecrets(relayCrypto, secret);
    // Registered with the pairing token the offer's secret derives, as a real host does.
    const { channel, hostToken } = await register({ pairToken });
    const hostKey = await relayCrypto.generateKeyPair();
    const appKey = await relayCrypto.generateKeyPair();
    const wire: Uint8Array[] = [];

    const first = await session(
      channel,
      { host: hostToken, app: pairToken },
      { psk, host: hostKey, app: appKey, pairedApp: null },
      wire,
    );
    const answer = await first.client.fetch(SECRET_PATH, { method: "POST", body: SECRET_BODY });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(`POST ${SECRET_PATH} ${SECRET_BODY}`);
    expect(first.hostChannel.peerKey).toEqual(appKey.publicKey);

    // The first data record opened, so the host confirms the pairing on the relay.
    const pairingKey = first.hostChannel.pairingKey;
    const appToken = await relayAppToken(relayCrypto, pairingKey);
    const confirmed = await call(`/v1/channels/${channel}/app`, {
      method: "PUT",
      token: hostToken,
      body: JSON.stringify({ appVerifier: await relayVerifier(relayCrypto, appToken) }),
    });
    expect(confirmed.status).toBe(204);
    for (const ws of first.sockets) ws.close(1000, "done");

    // A later session: the app derives its token again, both ends use the pairing key as psk.
    const later = await session(
      channel,
      { host: hostToken, app: await relayAppToken(relayCrypto, first.appChannel.pairingKey) },
      { psk: pairingKey, host: hostKey, app: appKey, pairedApp: appKey.publicKey },
      wire,
    );
    const again = await later.client.fetch(`${SECRET_PATH}?again=1`);
    expect(await again.text()).toBe(`GET ${SECRET_PATH} `);

    const plain = new TextEncoder();
    expect(wire.length).toBeGreaterThan(4);
    for (const message of wire) {
      expect(contains(message, plain.encode(SECRET_BODY))).toBe(false);
      expect(contains(message, plain.encode("very-private-path"))).toBe(false);
    }
    for (const ws of later.sockets) ws.close(1000, "done");
  });
});
