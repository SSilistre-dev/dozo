import * as z from "zod";

/**
 * The relay protocol between a phone ("app") and the user's own computer ("host"): the pairing
 * offer, the relay's HTTP and socket contract, and the multiplexed frames inside the sealed
 * channel. The wire format and the threat model: `dozo/relay/PROTOCOL.md`.
 */

/** Protocol version: in the relay's paths (`/v1/`), the offer and the handshake label. */
export const RELAY_PROTOCOL_VERSION = 1;

/** How long a pairing offer (QR code or deep link) can be used, once. */
export const RELAY_PAIRING_TTL_MS = 10 * 60 * 1000;

/** Largest plaintext of one sealed record; a record carries one or more frames. */
export const RELAY_MAX_RECORD_PLAINTEXT = 64 * 1024;
/** A sealed record adds a type byte, an 8-byte counter and a 16-byte tag. */
export const RELAY_RECORD_OVERHEAD = 25;
/** Largest message a relay must carry; larger ones may be refused. */
export const RELAY_MAX_MESSAGE_BYTES = RELAY_MAX_RECORD_PLAINTEXT + RELAY_RECORD_OVERHEAD;

/** Largest payload of one frame (a body chunk or a JSON head). */
export const RELAY_MAX_FRAME_PAYLOAD = 32 * 1024;
/** A frame header: type (1 byte), stream id (4 bytes), payload length (2 bytes). */
export const RELAY_FRAME_HEADER_BYTES = 7;
/** Body bytes a stream may send in each direction before the reader grants more. */
export const RELAY_STREAM_WINDOW = 256 * 1024;
/** Streams one app may have open at a time. */
export const RELAY_MAX_STREAMS = 128;
/** Largest request body the host forwards by default. */
export const RELAY_MAX_REQUEST_BODY = 32 * 1024 * 1024;

/** The first byte of every binary socket message. */
export const RelayRecordType = { hello: 1, welcome: 2, data: 3 } as const;

/** The first byte of every frame inside a sealed record. */
export const RelayFrameType = {
  request: 1,
  response: 2,
  data: 3,
  end: 4,
  cancel: 5,
  window: 6,
} as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const Base64Url = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/);

/** 32 bytes, base64url without padding: keys, secrets and SHA-256 verifiers. */
export const RelayKey = Base64Url(32);
/** A channel id: 16 random bytes, base64url without padding. */
export const RelayChannelId = Base64Url(16);

/** What the host shows as a QR code or deep link so a phone can pair, once, before it expires. */
export const RelayPairingOfferSchema = /* @__PURE__ */ z.object({
  v: z.literal(RELAY_PROTOCOL_VERSION),
  /** The relay's base address: https, or http on a loopback address for local runs. */
  relay: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  }, "The relay must use https"),
  channel: RelayChannelId,
  /** The host's long-term X25519 public key. */
  hostKey: RelayKey,
  /** 256 random bits; the phone derives the pairing key and the relay token from it. */
  secret: RelayKey,
  /** Milliseconds since the epoch. */
  expiresAt: z.number().int().positive(),
});
export type RelayPairingOffer = z.infer<typeof RelayPairingOfferSchema>;

/**
 * What the phone keeps after pairing, read back from its secure store. Keys are base64url. The
 * pairing secret is never stored; `originId` is random and names the computer's address inside
 * the app, so nothing the app loads by that address carries the channel id.
 */
export const RelayAppPairingSchema = /* @__PURE__ */ z.object({
  relay: RelayPairingOfferSchema.shape.relay,
  channel: RelayChannelId,
  hostKey: RelayKey,
  appPublicKey: RelayKey,
  appPrivateKey: RelayKey,
  /** The key of the pairing session, the `psk` of every later one. */
  pairingKey: RelayKey,
  originId: z.string().regex(/^[0-9a-f]{32}$/),
  pairedAt: z.number().int().nonnegative(),
});
export type RelayAppPairing = z.infer<typeof RelayAppPairingSchema>;

const HeaderList = /* @__PURE__ */ z
  .array(z.tuple([z.string().min(1).max(256), z.string().max(8192)]))
  .max(256);

/** The `request` frame: opens a stream from the app. */
export const RelayRequestHeadSchema = /* @__PURE__ */ z.object({
  method: z.string().regex(/^[A-Z]{1,16}$/),
  /** Path and query only, always starting with one `/`; the host owns the origin. */
  path: z
    .string()
    .max(8192)
    .regex(/^\/(?!\/)/),
  headers: HeaderList,
  /** Whether `data` frames follow before `end`; false for a request without a body. */
  body: z.boolean(),
});
export type RelayRequestHead = z.infer<typeof RelayRequestHeadSchema>;

/** The `response` frame: the host's status and headers; the body follows as `data` frames. */
export const RelayResponseHeadSchema = /* @__PURE__ */ z.object({
  status: z.number().int().min(200).max(599),
  statusText: z.string().max(256),
  headers: HeaderList,
});
export type RelayResponseHead = z.infer<typeof RelayResponseHeadSchema>;

/** `POST /v1/channels`: the host creates a channel; no account, only verifiers. */
export const RelayRegisterRequestSchema = /* @__PURE__ */ z.object({
  hostVerifier: RelayKey,
  pairVerifier: RelayKey,
  pairExpiresAt: z.number().int().positive(),
});
export const RelayRegisterResponseSchema = /* @__PURE__ */ z.object({ channel: RelayChannelId });

/** `PUT /v1/channels/{channel}/app`: after pairing, the host sets the phone's verifier. */
export const RelaySetAppRequestSchema = /* @__PURE__ */ z.object({ appVerifier: RelayKey });

/** A text message the relay sends on a socket: whether the other end is connected now. */
export const RelayPeerMessageSchema = /* @__PURE__ */ z.object({
  type: z.literal("peer"),
  present: z.boolean(),
});
export type RelayPeerMessage = z.infer<typeof RelayPeerMessageSchema>;

/**
 * A paired phone's sign-in from its computer (`dozo/relay/agent/README.md`, Phone sign-in). The
 * phone asks at this path through the relay. The computer's agent holds the request until the user
 * approved the phone on the computer, then adds the channel the request came on and its proof of
 * the key it shares with the local server; it removes these headers from every other request it
 * forwards. The local server answers with a session for its account, once per channel.
 */
export const RELAY_SESSION_PATH = "/api/auth/dozo/relay-session";
/** Where the agent ends a phone's sign-in when the phone is removed. */
export const RELAY_SESSION_REVOKE_PATH = "/api/auth/dozo/relay-session/revoke";
/** `<milliseconds>.<hex HMAC-SHA-256 of relayAgentProofMessage under the shared key>`. */
export const RELAY_AGENT_PROOF_HEADER = "x-dozo-relay-agent-proof";
export const RELAY_CHANNEL_HEADER = "x-dozo-relay-channel";

/** What the agent's proof covers, so a proof fits one request kind, one channel and one minute. */
export function relayAgentProofMessage(request: {
  method: string;
  path: string;
  channel: string;
  time: number;
}) {
  return `dozo-relay/${RELAY_PROTOCOL_VERSION} agent ${request.method.toUpperCase()} ${request.path} ${request.channel} ${request.time}`;
}

/** What the phone says about itself when it asks: shown on the computer beside the code. */
export const RelaySessionRequestSchema = /* @__PURE__ */ z.object({
  platform: z.enum(["ios", "android", "web"]).optional(),
});

/** The session the computer gives: the bearer token the app signs in with. */
export const RelaySessionSchema = /* @__PURE__ */ z.object({ token: z.string().min(1).max(2048) });
/**
 * Why the computer gave none: nobody signed in there, more than one account, given before, or the
 * phone was not approved on the computer in time.
 */
export const RelaySessionRefusalSchema = /* @__PURE__ */ z.object({
  reason: z.enum(["sign-in-on-computer", "one-account", "used", "not-approved"]),
});
export type RelaySessionRefusal = z.infer<typeof RelaySessionRefusalSchema>["reason"];
