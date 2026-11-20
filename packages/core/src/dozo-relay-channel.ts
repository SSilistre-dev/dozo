import type { RelayPairingOffer } from "@rakazo/contracts";
import {
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_PROTOCOL_VERSION,
  RelayPairingOfferSchema,
  RelayRecordType,
} from "@rakazo/contracts";

/**
 * The sealed channel between a phone ("app") and the user's computer ("host") through a relay
 * that sees only ciphertext. Handshake, keys and record layout: `dozo/relay/PROTOCOL.md`.
 */

export type RelayKeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

export type RelayAead = {
  seal(nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Rejects when the tag does not match. */
  open(nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
};

/**
 * The primitives the channel needs: X25519, HKDF-SHA-256, SHA-256 and AES-256-GCM. The default
 * is WebCrypto; a runtime without it (React Native's engine) passes an implementation built on an
 * audited library with the same algorithms.
 */
export type RelayCrypto = {
  randomBytes(length: number): Uint8Array;
  generateKeyPair(): Promise<RelayKeyPair>;
  dh(own: RelayKeyPair, peerPublicKey: Uint8Array): Promise<Uint8Array>;
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  aead(key: Uint8Array): Promise<RelayAead>;
};

/** Receives what a duplex delivers, in order, until it closes once. */
export type RelayReceiver = { receive(data: Uint8Array): void; closed(error: Error): void };

/** A message pipe: the relay socket below the channel, and the channel below the multiplexer. */
export type RelayDuplex = {
  send(data: Uint8Array): void;
  close(reason: string): void;
  /** Messages that arrived before a receiver was attached are delivered to it then. */
  attach(receiver: RelayReceiver): void;
};

export type RelayChannel = RelayDuplex & {
  /** The other end's long-term public key: the host learns the phone's from the pairing. */
  peerKey: Uint8Array;
  /** Both ends store it after pairing; it is the `psk` of every later session. */
  pairingKey: Uint8Array;
};

export class RelayChannelError extends Error {
  override name = "RelayChannelError";
}

const KEY = 32;
const TAG = 16;
const HELLO_BYTES = 1 + KEY + KEY + TAG;
const WELCOME_BYTES = 1 + KEY + TAG;
const DATA_HEADER = 9;
const LABEL = utf8(`dozo-relay/${RELAY_PROTOCOL_VERSION}`);
const APP_TO_HOST = 1;
const HOST_TO_APP = 2;

type SessionOptions = {
  crypto: RelayCrypto;
  /** The relay socket of this connection; a new connection needs a new channel. */
  transport: RelayDuplex;
  /** The channel id from the offer: binds the session to it. */
  channel: string;
  /** The pairing offer's key while pairing, the stored pairing key afterwards. */
  psk: Uint8Array;
};

/** The phone's end: sends `hello` at once and resolves when the host's `welcome` checks out. */
export function openAppChannel(
  options: SessionOptions & { appKey: RelayKeyPair; hostKey: Uint8Array },
): Promise<RelayChannel> {
  const session = new Session(options, "app");
  return session.start(async (first) => {
    const { crypto, appKey, hostKey, psk } = options;
    const ephemeral = await crypto.generateKeyPair();
    const th1 = await transcript(
      crypto,
      options.channel,
      hostKey,
      appKey.publicKey,
      ephemeral.publicKey,
    );
    const ikm1 = concat(await crypto.dh(ephemeral, hostKey), await crypto.dh(appKey, hostKey));
    const helloKey = await crypto.hkdf(ikm1, psk, concat(LABEL, utf8(" hello"), th1), KEY);
    const tag1 = await (await crypto.aead(helloKey)).seal(nonce(0), th1, new Uint8Array(0));
    session.sendRaw(concat([RelayRecordType.hello], appKey.publicKey, ephemeral.publicKey, tag1));

    const welcome = await first();
    if (welcome.length !== WELCOME_BYTES || welcome[0] !== RelayRecordType.welcome) {
      throw new RelayChannelError("expected a welcome");
    }
    const hostEphemeral = welcome.subarray(1, 1 + KEY);
    const ikm2 = concat(
      ikm1,
      await crypto.dh(ephemeral, hostEphemeral),
      await crypto.dh(appKey, hostEphemeral),
    );
    const keys = await sessionKeys(crypto, ikm2, psk, th1, hostEphemeral);
    await openTag(crypto, keys.welcome, keys.th2, welcome.subarray(1 + KEY));
    return { ...keys, peerKey: hostKey, sendKey: keys.appToHost, receiveKey: keys.hostToApp };
  });
}

/**
 * The computer's end: waits for `hello`. With `appKey` null it pairs and accepts any phone that
 * knows the offer's secret; otherwise only the paired phone.
 */
export function acceptHostChannel(
  options: SessionOptions & { hostKey: RelayKeyPair; appKey: Uint8Array | null },
): Promise<RelayChannel> {
  const session = new Session(options, "host");
  return session.start(async (first) => {
    const { crypto, hostKey, psk } = options;
    const hello = await first();
    if (hello.length !== HELLO_BYTES || hello[0] !== RelayRecordType.hello) {
      throw new RelayChannelError("expected a hello");
    }
    const appKey = hello.slice(1, 1 + KEY);
    const appEphemeral = hello.subarray(1 + KEY, 1 + 2 * KEY);
    if (options.appKey && !equalBytes(appKey, options.appKey)) {
      throw new RelayChannelError("not the paired app");
    }
    const th1 = await transcript(crypto, options.channel, hostKey.publicKey, appKey, appEphemeral);
    const ikm1 = concat(await crypto.dh(hostKey, appEphemeral), await crypto.dh(hostKey, appKey));
    const helloKey = await crypto.hkdf(ikm1, psk, concat(LABEL, utf8(" hello"), th1), KEY);
    await openTag(crypto, helloKey, th1, hello.subarray(1 + 2 * KEY));

    const ephemeral = await crypto.generateKeyPair();
    const ikm2 = concat(
      ikm1,
      await crypto.dh(ephemeral, appEphemeral),
      await crypto.dh(ephemeral, appKey),
    );
    const keys = await sessionKeys(crypto, ikm2, psk, th1, ephemeral.publicKey);
    const tag2 = await (await crypto.aead(keys.welcome)).seal(
      nonce(0),
      keys.th2,
      new Uint8Array(0),
    );
    session.sendRaw(concat([RelayRecordType.welcome], ephemeral.publicKey, tag2));
    return { ...keys, peerKey: appKey, sendKey: keys.hostToApp, receiveKey: keys.appToHost };
  });
}

type Established = {
  th2: Uint8Array;
  pairingKey: Uint8Array;
  peerKey: Uint8Array;
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
};

class Session implements RelayChannel {
  peerKey: Uint8Array = new Uint8Array(0);
  pairingKey: Uint8Array = new Uint8Array(0);
  private readonly sendDirection: number;
  private readonly receiveDirection: number;
  private handshake: ((data: Uint8Array) => void) | null = null;
  private early: Uint8Array[] = [];
  private sealer: { aead: RelayAead; aad: Uint8Array } | null = null;
  private opener: { aead: RelayAead; aad: Uint8Array } | null = null;
  private sent = 0;
  private received = 0;
  private outbound = Promise.resolve();
  private inbound = Promise.resolve();
  private receiver: RelayReceiver | null = null;
  private pending: Uint8Array[] = [];
  private failure: Error | null = null;
  private fail: (error: Error) => void = () => {};

  constructor(
    private readonly options: SessionOptions,
    role: "app" | "host",
  ) {
    this.sendDirection = role === "app" ? APP_TO_HOST : HOST_TO_APP;
    this.receiveDirection = role === "app" ? HOST_TO_APP : APP_TO_HOST;
    options.transport.attach({
      receive: (data) => this.onTransport(data),
      closed: (error) =>
        this.shut(new RelayChannelError(`relay connection closed: ${error.message}`)),
    });
  }

  async start(
    run: (first: () => Promise<Uint8Array>) => Promise<Established>,
  ): Promise<RelayChannel> {
    // The transport may have closed while it was attached, before `fail` existed.
    if (this.failure) throw this.failure;
    const failed = new Promise<never>((_, reject) => {
      this.fail = reject;
    });
    const first = () =>
      Promise.race([
        failed,
        new Promise<Uint8Array>((resolve) => {
          const early = this.early.shift();
          if (early) resolve(early);
          else this.handshake = resolve;
        }),
      ]);
    try {
      const established = await Promise.race([failed, run(first)]);
      const { crypto } = this.options;
      this.sealer = {
        aead: await crypto.aead(established.sendKey),
        aad: concat([this.sendDirection], established.th2),
      };
      this.opener = {
        aead: await crypto.aead(established.receiveKey),
        aad: concat([this.receiveDirection], established.th2),
      };
      this.peerKey = established.peerKey;
      this.pairingKey = established.pairingKey;
      if (this.failure) throw this.failure;
      for (const data of this.early.splice(0)) this.onTransport(data);
      return this;
    } catch (error) {
      this.shut(error as Error);
      throw error;
    }
  }

  sendRaw(data: Uint8Array) {
    this.options.transport.send(data);
  }

  send(plaintext: Uint8Array) {
    const sealer = this.sealer;
    if (!sealer || this.failure) return;
    if (plaintext.length + DATA_HEADER + TAG > RELAY_MAX_MESSAGE_BYTES) {
      throw new RelayChannelError("record too large");
    }
    this.sent += 1;
    const header = new Uint8Array(DATA_HEADER);
    header[0] = RelayRecordType.data;
    new DataView(header.buffer).setBigUint64(1, BigInt(this.sent));
    const sealing = sealer.aead.seal(nonce(this.sent), sealer.aad, plaintext);
    // Sealing runs at once; records leave in counter order.
    this.outbound = this.outbound.then(async () => {
      const sealed = await sealing;
      if (!this.failure) this.options.transport.send(concat(header, sealed));
    });
  }

  close(reason: string) {
    this.shut(new RelayChannelError(reason));
  }

  attach(receiver: RelayReceiver) {
    this.receiver = receiver;
    for (const data of this.pending.splice(0)) receiver.receive(data);
    if (this.failure) receiver.closed(this.failure);
  }

  private onTransport(data: Uint8Array) {
    if (this.failure) return;
    const opener = this.opener;
    if (!opener) {
      const waiting = this.handshake;
      this.handshake = null;
      if (waiting) waiting(data);
      else this.early.push(data);
      return;
    }
    if (data.length > RELAY_MAX_MESSAGE_BYTES)
      return this.shut(new RelayChannelError("record too large"));
    if (data.length < DATA_HEADER + TAG || data[0] !== RelayRecordType.data) {
      return this.shut(new RelayChannelError("malformed record"));
    }
    const counter = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(1));
    if (counter !== this.received + 1)
      return this.shut(new RelayChannelError("record out of order or replayed"));
    this.received = counter;
    const opening = opener.aead
      .open(nonce(counter), opener.aad, data.subarray(DATA_HEADER))
      .catch(() => null);
    // Opening runs at once; messages are delivered in counter order.
    this.inbound = this.inbound.then(async () => {
      const plaintext = await opening;
      if (this.failure) return;
      if (!plaintext) return this.shut(new RelayChannelError("record failed authentication"));
      if (!this.receiver) return void this.pending.push(plaintext);
      try {
        this.receiver.receive(plaintext);
      } catch (error) {
        this.shut(new RelayChannelError(`receiver failed: ${(error as Error).message}`));
      }
    });
  }

  private shut(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.fail(error);
    this.options.transport.close(error.message);
    this.receiver?.closed(error);
  }
}

async function transcript(
  crypto: RelayCrypto,
  channel: string,
  hostKey: Uint8Array,
  appKey: Uint8Array,
  appEphemeral: Uint8Array,
) {
  return crypto.sha256(concat(LABEL, utf8(channel), hostKey, appKey, appEphemeral));
}

async function sessionKeys(
  crypto: RelayCrypto,
  ikm: Uint8Array,
  psk: Uint8Array,
  th1: Uint8Array,
  hostEphemeral: Uint8Array,
) {
  const th2 = await crypto.sha256(concat(th1, hostEphemeral));
  const okm = await crypto.hkdf(ikm, psk, concat(LABEL, utf8(" session"), th2), 4 * KEY);
  return {
    th2,
    welcome: okm.slice(0, KEY),
    appToHost: okm.slice(KEY, 2 * KEY),
    hostToApp: okm.slice(2 * KEY, 3 * KEY),
    pairingKey: okm.slice(3 * KEY),
  };
}

async function openTag(crypto: RelayCrypto, key: Uint8Array, aad: Uint8Array, tag: Uint8Array) {
  try {
    await (await crypto.aead(key)).open(nonce(0), aad, tag);
  } catch {
    throw new RelayChannelError("handshake failed authentication");
  }
}

/** The pairing secret's two uses: the first session's `psk`, and the relay token while pairing. */
export async function relayPairingSecrets(crypto: RelayCrypto, secret: Uint8Array) {
  const psk = await crypto.hkdf(
    secret,
    new Uint8Array(0),
    concat(LABEL, utf8(" pairing psk")),
    KEY,
  );
  const token = await crypto.hkdf(
    secret,
    new Uint8Array(0),
    concat(LABEL, utf8(" pairing token")),
    KEY,
  );
  return { psk, token: encodeRelayBytes(token) };
}

/** The phone's relay token after pairing; the host derives the same one to register its verifier. */
export async function relayAppToken(crypto: RelayCrypto, pairingKey: Uint8Array) {
  return encodeRelayBytes(
    await crypto.hkdf(pairingKey, new Uint8Array(0), concat(LABEL, utf8(" app token")), KEY),
  );
}

/** What the relay stores for a token: its SHA-256, base64url. */
export async function relayVerifier(crypto: RelayCrypto, token: string) {
  return encodeRelayBytes(await crypto.sha256(utf8(token)));
}

/** The text of a QR code or deep link parameter: base64url of the offer's JSON. */
export function encodeRelayPairingOffer(offer: RelayPairingOffer) {
  return encodeRelayBytes(utf8(JSON.stringify(RelayPairingOfferSchema.parse(offer))));
}

/**
 * What the QR code holds: a link the phone's camera opens in the app. The offer travels after `#`,
 * which no browser or server receives, so it never lands in a log or a referrer.
 */
export function relayPairingLink(offerText: string) {
  return `rakazo://dozo-pair#${offerText}`;
}

/** Throws on a malformed or expired offer. */
export function parseRelayPairingOffer(text: string, now: number): RelayPairingOffer {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeRelayBytes(text)));
  } catch {
    throw new RelayChannelError("not a pairing offer");
  }
  const parsed = RelayPairingOfferSchema.safeParse(json);
  if (!parsed.success) throw new RelayChannelError("not a pairing offer");
  if (parsed.data.expiresAt <= now) throw new RelayChannelError("pairing offer expired");
  return parsed.data;
}

/** The channel's primitives on WebCrypto (Node, browsers, Electron). */
export function webRelayCrypto(crypto: Crypto = globalThis.crypto): RelayCrypto {
  const { subtle } = crypto;
  const X25519 = { name: "X25519" };
  return {
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    async generateKeyPair() {
      const pair = (await subtle.generateKey(X25519, true, ["deriveBits"])) as CryptoKeyPair;
      const jwk = await subtle.exportKey("jwk", pair.privateKey);
      return {
        publicKey: decodeRelayBytes(String(jwk.x)),
        privateKey: decodeRelayBytes(String(jwk.d)),
      };
    },
    async dh(own, peerPublicKey) {
      const jwk = {
        kty: "OKP",
        crv: "X25519",
        x: encodeRelayBytes(own.publicKey),
        d: encodeRelayBytes(own.privateKey),
      };
      const privateKey = await subtle.importKey("jwk", jwk, X25519, false, ["deriveBits"]);
      const publicKey = await subtle.importKey("raw", buffer(peerPublicKey), X25519, false, []);
      return new Uint8Array(
        await subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256),
      );
    },
    async hkdf(ikm, salt, info, length) {
      const key = await subtle.importKey("raw", buffer(ikm), "HKDF", false, ["deriveBits"]);
      const params = { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(info) };
      return new Uint8Array(await subtle.deriveBits(params, key, length * 8));
    },
    sha256: async (data) => new Uint8Array(await subtle.digest("SHA-256", buffer(data))),
    async aead(raw) {
      const key = await subtle.importKey("raw", buffer(raw), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      const params = (iv: Uint8Array, aad: Uint8Array) => ({
        name: "AES-GCM",
        iv: buffer(iv),
        additionalData: buffer(aad),
      });
      return {
        seal: async (iv, aad, data) =>
          new Uint8Array(await subtle.encrypt(params(iv, aad), key, buffer(data))),
        open: async (iv, aad, data) =>
          new Uint8Array(await subtle.decrypt(params(iv, aad), key, buffer(data))),
      };
    },
  };
}

export function encodeRelayBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRelayBytes(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function nonce(counter: number) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

function utf8(text: string) {
  return new TextEncoder().encode(text);
}

function concat(...parts: ArrayLike<number>[]) {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** WebCrypto's types want a plain ArrayBuffer behind the view. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
