# Relay host agent

The agent runs on the user's computer next to the local Dozo server. It keeps one socket per
paired phone open to a relay and forwards each sealed request to the server on loopback, so a
phone reaches the computer from anywhere without an open port. The wire format is
`dozo/relay/PROTOCOL.md`.

The code lives in upstream directories as `dozo-*` files, so Vitest, tsc, Biome and the fork's
unit gate cover it:

| File | What |
| --- | --- |
| `packages/core/src/dozo-relay-ws.ts` | `wsDuplex`: one relay WebSocket as protocol sessions, on either end (the phone uses it too) |
| `packages/core/src/dozo-relay-host.ts` | pairing, list, revoke and the run loop, with storage, sockets and HTTP passed in |
| `packages/adapters/src/dozo-relay-file-store.ts` | the state on disk |
| `packages/adapters/src/dozo-relay-agent.ts` | the command line |
| `packages/adapters/src/dozo-relay-dev-relay.ts` | a relay in memory, for tests and local runs only |

## Commands

```
dozo-relay-agent pair --relay <https address> [--state <dir>]
dozo-relay-agent run --origin http://127.0.0.1:<port> [--state <dir>]
dozo-relay-agent list [--state <dir>]
dozo-relay-agent revoke <channel> [--origin http://127.0.0.1:<port>] [--state <dir>]
```

- `pair` registers a channel on the relay and prints one line,
  `{"event":"offer","channel","relay","expiresAt","qr"}`. `qr` is what the QR code holds: the
  pairing link `rakazo://dozo-pair#<offer>` (`dozo/relay/PROTOCOL.md`, Pairing link). The offer works once, for 10 minutes, and only while `run`
  is connected: `run` notices the new channel by itself.
- `run` stays connected until SIGINT or SIGTERM, then closes every socket and prints
  `{"event":"stopped"}`. `--origin` must be a loopback address; the agent forwards nowhere else.
- `list` prints `{"channels":[{"channel","relay","state":"paired","appKey","pairedAt"} |
  {"channel","relay","state":"pairing","expiresAt"}]}`, never a key or token.
- `revoke` deletes the channel on the relay (both sockets close) and forgets its keys, which go
  even when the relay cannot be reached: `{"event":"revoked","channel","relay":"deleted"|"unreachable"}`.

Exit codes: 0 done, 2 failed, 64 usage error. Every stdout line is one JSON object; a failure is
`{"event":"error","reason"}` before the exit code.

The relay address has no default: https, or http on a loopback address for local runs.

## Phone sign-in

A local server with `DOZO_RELAY_AGENT_KEY` set (64 hexadecimal digits, random, kept with the
server's other secrets) signs a paired phone in as its one account, while that account is signed
in on the computer. The phone never sees a password. The agent gets the same value in its
environment for `run` and `revoke`; without it, phones get no sign-in from this computer.

- The phone asks with `POST /api/auth/dozo/relay-session` through the relay. On that request only,
  `run` adds `x-dozo-relay-agent-key` and `x-dozo-relay-channel` (the channel the request came
  on). It removes both headers from every request a phone sends, so a phone can neither name
  another channel nor carry a key of its own.
- The local server answers only a request from this computer with the key, compared in constant
  time; anyone else gets 404. It gives each channel one session, ever: `200 { token }`, or `409
  { reason: "sign-in-on-computer" | "one-account" }`, or `410 { reason: "used" }`. The token
  crosses only inside the sealed channel and is never logged.
- The session ends when the phone is removed: `revoke --origin` ends it on the local server
  (`"session": "revoked" | "unreachable"` in its line), and so does `run` when the relay no
  longer knows the channel (an `error` event if the server could not be reached). It also ends
  when the user signs out on the computer, or when the phone signs out. A removed phone pairs
  again to get a new one.

## Events from `run`

One JSON object per line, for the desktop app to show state:

| Event | Fields | When |
| --- | --- | --- |
| `connected` | `channel` | the relay socket is open |
| `peer` | `channel`, `present` | the phone connected to the relay or went away |
| `paired` | `channel`, `appKey` | the phone's first record opened; the offer is used up |
| `disconnected` | `channel`, `reason`, `retryInMs` | the socket could not open or closed; the next try is in `retryInMs` |
| `refused` | `channel`, `reason` | a session failed its handshake (not the paired phone, expired offer) |
| `revoked` | `channel` | the relay no longer knows the channel (the phone removed it); its keys are gone |
| `expired` | `channel` | an offer ran out unused; its channel is gone |
| `error` | `reason`, maybe `channel` | storage or the relay failed; the agent keeps trying |
| `stopped` | | `run` closed everything and is about to exit |

Reconnects back off with the shared `retry` policy (250 ms doubling to 30 s, longer when the relay
answers 429 with `Retry-After`). After a socket that was open closes, the next try starts within
5 seconds at a random moment, so a relay restart is not answered by every computer at once.

## State

Default directory: `~/Library/Application Support/dozo/relay` on macOS,
`%APPDATA%\dozo\relay` on Windows, `$XDG_CONFIG_HOME/dozo/relay` (or `~/.config/dozo/relay`)
elsewhere. Directories are 0700 and files 0600; each write goes to a new hidden file that is renamed
into place.

- `host-key.json`: `{ publicKey, privateKey }`, the host's X25519 key pair (base64url), made once.
- `channels/<channel>.json`: `{ channel, relay, hostToken, createdAt, pairing, app }`.
  `pairing` is `{ psk, expiresAt }` while the offer is open; `app` is
  `{ key, pairingKey, verifierSet, pairedAt }` after pairing. The pairing secret itself is never
  stored.

One file per channel lets `pair`, `run` and `revoke` work at the same time without a lock. The
storage is one interface (`RelayHostStore`), so the keys can move to the system key store without
touching the rest.

## Local run

In Docker, from a workspace with dependencies installed:

```
pnpm exec tsx packages/adapters/src/dozo-relay-agent.ts pair --relay http://127.0.0.1:8787
```

The dev relay is started from a test or a script with `startDevRelay({ port: 8787 })`.
