# Relay protocol, version 1

A phone ("app") reaches the server on the user's own computer ("host") through a relay. Both ends
open one WebSocket each to the relay; the relay pairs the two sockets of a channel and copies
binary messages between them. Everything the ends say to each other is sealed end to end: the
relay stores verifiers only and never holds a key that opens the traffic.

This document is enough to write another relay or another end. The reference ends are
`packages/core/src/dozo-relay-channel.ts` (sealed channel) and `packages/core/src/dozo-relay-mux.ts`
(multiplexer); the constants and JSON shapes are in `packages/contracts/src/dozo-relay.ts`.

## Conventions

- Integers on the wire are unsigned big-endian.
- "base64url" is RFC 4648 section 5 without padding. Keys, secrets and verifiers are 32 bytes
  (43 characters); channel ids are 16 bytes (22 characters).
- `LABEL` is the ASCII string `dozo-relay/1`. `||` is concatenation.
- `HKDF(ikm, salt, info, n)` is HKDF-SHA-256 (RFC 5869); an empty salt means 32 zero bytes.
- `AEAD` is AES-256-GCM with a 12-byte nonce and a 16-byte tag. `DH` is X25519 (RFC 7748).

## Versioning

The version appears in the relay's paths (`/v1/`), the pairing offer (`v: 1`) and `LABEL`. A change
that an older end cannot read takes a new number everywhere; a relay serves each version it knows
under its own path. An end refuses an offer or a handshake of a version it does not know.

## Pairing

1. The host makes a long-term X25519 key pair (once) and, for each pairing, a 32-byte random
   `secret`. From it: `psk = HKDF(secret, "", LABEL || " pairing psk", 32)` and
   `pairToken = base64url(HKDF(secret, "", LABEL || " pairing token", 32))`.
2. The host makes its own random 32-byte `hostToken` and registers a channel (below) with the
   verifiers of `hostToken` and `pairToken` and an expiry 10 minutes ahead.
3. The host shows the offer as a QR code or deep link: base64url of the UTF-8 JSON
   `{ v, relay, channel, hostKey, secret, expiresAt }` (`RelayPairingOfferSchema`). The phone
   refuses an offer that does not parse or whose `expiresAt` has passed, and a relay address that
   is not https (plain http only on a loopback address, for local runs).
4. The phone makes its long-term X25519 key pair, connects as the app with `pairToken`, and runs
   the handshake with `psk`. The host accepts any app key in this one session.
5. Both ends keep the session's `pairingKey`. Once the first data record from the phone has opened
   in that session (which proves the phone got the `welcome`), the host derives
   `appToken = base64url(HKDF(pairingKey, "", LABEL || " app token", 32))` and sets its verifier on
   the relay, which deletes the pairing verifier. So the phone sends a request (any request) as
   soon as its first session opens; until then the pairing is not complete. The host forgets `secret` and `psk`, and accepts
   no second pairing for that offer.
6. Stored afterwards. Host: channel, relay address, its key pair, the app's public key,
   `pairingKey`, `hostToken`. App: channel, relay address, the host's public key, its key pair,
   `pairingKey` (it derives `appToken` again when needed).

A verifier is `base64url(SHA-256(token))`, the token taken as its ASCII text.

## Relay contract

### HTTP

All bodies are JSON. Errors carry no detail. An unknown channel and a wrong token both answer
`404`, so a caller cannot tell them apart.

| Request | Auth | Body | Answer |
| --- | --- | --- | --- |
| `POST /v1/channels` | none | `{ hostVerifier, pairVerifier, pairExpiresAt }` | `201 { channel }` |
| `PUT /v1/channels/{channel}/app` | host token | `{ appVerifier }` | `204`; drops the pairing verifier |
| `DELETE /v1/channels/{channel}` | host or app token | none | `204`; closes both sockets, forgets the channel |
| `GET /v1/channels/{channel}/host` | host token | WebSocket upgrade | `101` |
| `GET /v1/channels/{channel}/app` | app token, or the pairing token before it expires and while no app verifier is set | WebSocket upgrade | `101` |

- Tokens travel as `Authorization: Bearer <token>`, on the WebSocket upgrade too. The relay hashes
  what it receives and compares verifiers in constant time. It never logs a token.
- An end tells a refused upgrade from a network failure by its status: `404` means the channel or
  the token is gone for good (the host forgets the channel's keys), anything else is retried with
  backoff, honoring `Retry-After`. So an end's WebSocket client must set a request header and
  report the upgrade's status; Node's and React Native's can, a browser's cannot.
- The relay picks the channel id: 16 random bytes.
- `400` for a body that does not parse; `429` with `Retry-After` when a limit is hit.
- The relay stores per channel: id, `hostVerifier`, `appVerifier` or `pairVerifier` with its
  expiry, and timestamps. Nothing else: no account, no content, no message log.
- It may delete a channel nobody connected to for a long time (at least 90 days). The ends then
  get `404` and pair again.

### Sockets

- One socket per role and channel. A new one replaces the old, which is closed with code `4000`.
- The relay sends text messages only of the form `{"type":"peer","present":true|false}`: once on
  open, and whenever the other role connects or goes away. That first message can arrive together
  with the upgrade's answer, so an end listens for messages before it hands the socket on.
- A binary message is forwarded unchanged and in order to the other role's socket, or dropped when
  that socket is not open. The relay never buffers, merges, splits or reorders messages.
- A text `ping` is answered with a text `pong` by the relay itself. Ends ping about every 25 seconds
  and treat 75 seconds without any message as a dead socket.
- Messages over 65,561 bytes (`RELAY_MAX_MESSAGE_BYTES`) may be refused with close code `1009`.

### Limits a relay is expected to apply

Registrations per client address (order of 30 a minute), connects per channel (order of 60 a
minute), failed token attempts per address, and bytes per channel. Exact numbers are the relay's
choice; it answers `429` and the ends back off.

## Sealed channel

A session lives as long as one pair of sockets. The app starts it when the relay says the host is
present. A `hello` that arrives while a session is open replaces it: the reference channel closes
on any record that is not data, and the host's socket code then answers that `hello` with a new
session. Neither end times a handshake out itself; the socket's 75-second silence rule does.
When the relay says the peer went away, both ends drop the session: open requests fail, and the
caller may send them again once a new handshake is done. New ephemeral keys on every session are the re-keying.

Every binary message starts with a type byte: `1` hello, `2` welcome, `3` data.

**hello** (app to host, 81 bytes): `1 || appStatic || appEphemeral || tag1`, where

```
th1     = SHA-256(LABEL || channel id (ASCII) || hostStatic || appStatic || appEphemeral)
ikm1    = DH(appEphemeral, hostStatic) || DH(appStatic, hostStatic)
k1      = HKDF(ikm1, psk, LABEL || " hello" || th1, 32)
tag1    = AEAD(k1, nonce = 12 zero bytes, aad = th1, plaintext = empty)
```

The host checks `tag1` (it proves the phone knows `psk` and holds `appStatic`'s private key) and,
after pairing, that `appStatic` is the stored app key. Anything else closes the session.

**welcome** (host to app, 49 bytes): `2 || hostEphemeral || tag2`, where

```
th2     = SHA-256(th1 || hostEphemeral)
ikm2    = ikm1 || DH(appEphemeral, hostEphemeral) || DH(appStatic, hostEphemeral)
okm     = HKDF(ikm2, psk, LABEL || " session" || th2, 128)
          = welcomeKey || appToHostKey || hostToAppKey || pairingKey   (32 bytes each)
tag2    = AEAD(welcomeKey, nonce = 12 zero bytes, aad = th2, plaintext = empty)
```

The app checks `tag2`; it proves the host holds `hostStatic`'s private key.

**data**: `3 || counter (8 bytes) || ciphertext || tag`, sealed with the sender's direction key,
`nonce = 4 zero bytes || counter (8 bytes)` and `aad = direction || th2`, where direction is `1`
for app to host and `2` for host to app. Counters start at 1 in each direction of each session and
rise by exactly one. A receiver closes the session on any record that is not the next counter,
fails its tag, is shorter than 25 bytes, or is larger than the limit. The plaintext is at most
65,536 bytes (`RELAY_MAX_RECORD_PLAINTEXT`).

## Multiplexer

A record's plaintext is one or more frames: `type (1) || stream (4) || length (2) || payload`,
payload at most 32,768 bytes. Frames written in the same turn share a record, so a request head
and its `end` cost one relay message.

| Type | Name | From | Payload |
| --- | --- | --- | --- |
| 1 | request | app | JSON `{ method, path, headers, body }` (`RelayRequestHeadSchema`) |
| 2 | response | host | JSON `{ status, statusText, headers }` (`RelayResponseHeadSchema`) |
| 3 | data | both | body bytes |
| 4 | end | both | empty: the sender's body is complete |
| 5 | cancel | both | UTF-8 reason, at most 256 bytes: the stream ends now, both ways |
| 6 | window | both | 4-byte credit increment for the body the receiver of this frame sends |

- Only the app opens streams, with a non-zero id that is not open. A request for an open id, or a
  request frame sent by the host, closes the whole channel.
- A request is `request`, then `data`* and `end` (`end` alone when `body` is false). A response is
  `response`, then `data`* and `end`. The stream is over when the response's `end` arrives, or
  after a `cancel` either way. Frames for a stream that is not open are ignored; an unknown type on
  an open stream cancels it.
- Flow control: each direction of each stream starts with 262,144 bytes of credit
  (`RELAY_STREAM_WINDOW`). A sender stops at zero; the reader grants more with `window` as its
  consumer reads. Data past the credit cancels the stream.
- Limits: 128 open streams per channel, request bodies of 32 MiB by default on the host, heads of
  one frame. A long-lived response (a server-sent event stream) is just a body that has not ended.
- `path` is the path and query only. The host resolves it against its fixed loopback origin and
  cancels a request that would leave it or does not parse. Hop-by-hop headers (`connection`,
  `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `host`, `proxy-connection`) never
  cross. The host also drops the request's `content-length` and the response's `content-length`
  and `content-encoding`: its loopback client streams the request again and hands over the
  response body already decoded.
- When the response ends before the request body did, the host stops reading the request body.
- The tunnel is transport, not authorization: the loopback server authenticates every request the
  way it would without the relay.

### Overhead

A record costs 25 bytes (type, counter, tag) and a frame 7. A frame alone in a record is 32 bytes
over its payload (measured in `dozo-relay-mux.test.ts`); a request with no body is one record of
`25 + 7 + head + 7` bytes. The handshake is 81 + 49 bytes. Body chunks of 32 KiB carry about 0.1%.

## Threat model

- **Network between an end and the relay.** Tokens travel in the clear inside TLS only, so the
  relay must be https; over plain http someone on the path could take a socket over and keep
  cutting sessions, though still not read them.
- **Relay, honest or not.** It learns channel ids, client addresses, timing, record sizes and
  counts, verifiers, the pairing token, and the public keys in the handshake (the app's static key
  links its sessions, which the channel id does anyway). It cannot read, forge, replay or reorder
  traffic: every record is sealed under keys from the ephemeral exchange and checked by counter.
  It can drop, delay or cut a session; the ends notice and reconnect. The pairing token is a
  separate HKDF output from `psk`, so seeing it does not help to pair.
- **Replay.** A replayed `hello` gets a fresh `welcome` nobody without the app's ephemeral key can
  use. A replayed `welcome` fails against the app's new ephemeral key. A replayed, reordered or
  dropped record closes the session.
- **QR code seen by someone else before the phone uses it.** They can pair first within the 10
  minutes and become the paired phone; the owner's phone then fails to pair, and the host shows
  which device is paired and offers to remove it. Seen after use: worthless, because the offer is
  single use on both the host and the relay.
- **Stolen phone or its storage.** `pairingKey` and the app key give the thief the phone's access
  until the host removes the pairing (`DELETE` on the relay and forgetting the keys).
- **Static keys stolen later.** Past sessions stay sealed: their keys came from ephemeral keys that
  were thrown away.
- **Splicing.** The channel id is in the transcript, so a session cannot be moved to another
  channel.
- **Exhaustion.** Stream, window, body, frame and record limits bound what one peer can make the
  other buffer.

## Runtime requirements

The reference ends use WebCrypto (X25519, HKDF, SHA-256, AES-GCM), which Node, Electron and current
browsers have. React Native's JavaScript engine has no `crypto.subtle`, so the phone passes its
own `RelayCrypto` with the same algorithms, built on an audited pure-JavaScript library (the
`@noble` curves, hashes and ciphers packages are the expected choice). The protocol code is the
same on both ends; only these six primitives are swapped.

The multiplexer's client also needs the web globals `ReadableStream`, `Request` and `Response`
with stream bodies, `AbortSignal`, `TextEncoder` and `TextDecoder`. On the phone these come from
the app's fetch runtime or polyfills; the phone's adapter checks them before it opens a channel.
