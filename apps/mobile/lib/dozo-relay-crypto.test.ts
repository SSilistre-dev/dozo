import { randomBytes } from "node:crypto";
import {
  acceptHostChannel,
  encodeRelayBytes,
  openAppChannel,
  relayAppToken,
  relayPairingSecrets,
  webRelayCrypto,
} from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { duplexPair } from "./dozo-relay.test-support";
import { nobleRelayCrypto } from "./dozo-relay-crypto";

// The phone's primitives against the computer's (WebCrypto): every value either end derives must
// be the other's, or no session ever opens.

const noble = nobleRelayCrypto((length) => new Uint8Array(randomBytes(length)));
const web = webRelayCrypto();
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe("nobleRelayCrypto", () => {
  it("agrees with WebCrypto on X25519 in both directions", async () => {
    const phone = await noble.generateKeyPair();
    const computer = await web.generateKeyPair();
    const a = await noble.dh(phone, computer.publicKey);
    const b = await web.dh(computer, phone.publicKey);
    expect(encodeRelayBytes(a)).toBe(encodeRelayBytes(b));
    expect(a).toHaveLength(32);
  });

  it("agrees on HKDF, with and without a salt, and on SHA-256", async () => {
    const ikm = bytes(32, 1);
    const info = new TextEncoder().encode("dozo-relay/1 test");
    for (const salt of [new Uint8Array(0), bytes(32, 2)]) {
      expect(await noble.hkdf(ikm, salt, info, 128)).toEqual(await web.hkdf(ikm, salt, info, 128));
    }
    expect(await noble.sha256(info)).toEqual(await web.sha256(info));
  });

  it("opens what WebCrypto sealed and the other way round, and refuses a changed record", async () => {
    const key = bytes(32, 3);
    const nonce = bytes(12, 4);
    const aad = bytes(5, 5);
    const plain = new TextEncoder().encode("sealed");
    const fromWeb = await (await web.aead(key)).seal(nonce, aad, plain);
    expect(await (await noble.aead(key)).open(nonce, aad, fromWeb)).toEqual(plain);
    const fromNoble = await (await noble.aead(key)).seal(nonce, aad, plain);
    expect(fromNoble).toEqual(fromWeb);
    expect(await (await web.aead(key)).open(nonce, aad, fromNoble)).toEqual(plain);
    fromNoble[0] = (fromNoble[0] as number) ^ 1;
    await expect((await noble.aead(key)).open(nonce, aad, fromNoble)).rejects.toThrow();
  });

  it("refuses a low-order peer key", async () => {
    await expect(noble.dh(await noble.generateKeyPair(), new Uint8Array(32))).rejects.toThrow();
  });

  it("derives the pairing secrets and the app token the computer derives", async () => {
    const secret = bytes(32, 6);
    expect(await relayPairingSecrets(noble, secret)).toEqual(
      await relayPairingSecrets(web, secret),
    );
    expect(await relayAppToken(noble, secret)).toBe(await relayAppToken(web, secret));
  });

  it("opens a session with a WebCrypto computer", async () => {
    const { app, host } = duplexPair();
    const hostKey = await web.generateKeyPair();
    const appKey = await noble.generateKeyPair();
    const psk = bytes(32, 7);
    const channel = encodeRelayBytes(bytes(16, 8));
    const [phone, computer] = await Promise.all([
      openAppChannel({
        crypto: noble,
        transport: app,
        channel,
        psk,
        appKey,
        hostKey: hostKey.publicKey,
      }),
      acceptHostChannel({ crypto: web, transport: host, channel, psk, hostKey, appKey: null }),
    ]);
    expect(phone.pairingKey).toEqual(computer.pairingKey);
    expect(computer.peerKey).toEqual(appKey.publicKey);
  });
});
