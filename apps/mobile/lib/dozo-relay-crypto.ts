import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { RelayCrypto } from "@rakazo/core";

/**
 * The relay channel's primitives (X25519, HKDF-SHA-256, SHA-256, AES-256-GCM) on the audited
 * `@noble` libraries, for React Native's engine, which has no WebCrypto. The same algorithms as
 * `webRelayCrypto`, so either end can use either (`dozo/relay/PROTOCOL.md`, Runtime requirements).
 * `randomBytes` must be a cryptographically secure source; the app passes the system's.
 */
export function nobleRelayCrypto(randomBytes: (length: number) => Uint8Array): RelayCrypto {
  return {
    randomBytes,
    async generateKeyPair() {
      const privateKey = randomBytes(32);
      return { publicKey: x25519.getPublicKey(privateKey), privateKey };
    },
    // Rejects a low-order peer key, as WebCrypto does.
    dh: async (own, peerPublicKey) => x25519.getSharedSecret(own.privateKey, peerPublicKey),
    hkdf: async (ikm, salt, info, length) => hkdf(sha256, ikm, salt, info, length),
    sha256: async (data) => sha256(data),
    async aead(key) {
      return {
        seal: async (nonce, aad, plaintext) => gcm(key, nonce, aad).encrypt(plaintext),
        open: async (nonce, aad, sealed) => gcm(key, nonce, aad).decrypt(sealed),
      };
    },
  };
}
