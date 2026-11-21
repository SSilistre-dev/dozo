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
dozo-relay-agent approve [--state <dir>] -- <channel>
dozo-relay-agent revoke [--origin http://127.0.0.1:<port>] [--state <dir>] -- <channel>
```

A channel id is base64url and can start with `-`: pass it after `--`, or it reads as an option.

- `pair` registers a channel on the relay and prints one line,
  `{"event":"offer","channel","relay","expiresAt","qr"}`. `qr` is what the QR code holds: the
  pairing link `dozo://pair#<offer>` (`dozo/relay/PROTOCOL.md`, Pairing link). The offer works once, for 10 minutes, and only while `run`
  is connected: `run` notices the new channel by itself.
- `run` stays connected until SIGINT or SIGTERM, then closes every socket and prints
  `{"event":"stopped"}`. `--origin` must be a loopback address; the agent forwards nowhere else.
- `list` prints `{"channels":[{"channel","relay","state":"paired","appKey","pairedAt","approved"} |
  {"channel","relay","state":"pairing","expiresAt"}]}`, never a key or token.
- `approve` records that the user approved the phone on a channel (Phone sign-in):
  `{"event":"approved","channel"}`.
- `revoke` deletes the channel on the relay (both sockets close) and forgets its keys, which go
  even when the relay cannot be reached:
  `{"event":"revoked","channel","relay":"deleted"|"unreachable","session":"revoked"|"unreachable"|"skipped"}`.

Exit codes: 0 done, 2 failed, 64 usage error. Every stdout line is one JSON object; a failure is
`{"event":"error","reason"}` before the exit code.

The relay address has no default: https, or http on a loopback address for local runs.

## Phone sign-in

A local server with `DOZO_RELAY_AGENT_KEY` set (64 hexadecimal digits, random, kept with the
server's other secrets) signs a paired phone in as its one account, once the user approved that
phone on the computer. The phone never sees a password. The agent gets the same value in its
environment for `run` and `revoke`; without it, phones get no sign-in from this computer, and the
local server wires none of this (no route, no hook), exactly as before. The server reads the key
once at start and removes it from its environment, so nothing it starts (a bot's command, a tool)
inherits it.

1. Right after pairing, the phone asks with `POST /api/auth/dozo/relay-session` through the relay
   (body `{ "platform": "ios" | "android" }`) and shows a six-digit code derived from the pairing
   key (`relayApprovalCode`), which only the two ends hold.
2. `run` holds that request and prints `{"event":"approval","channel","code","platform"}`. The
   desktop app shows the code and the platform and asks the user; `approve <channel>` records the
   answer (the user compares the codes). A running agent picks the approval up from its state and
   prints `{"event":"approved","channel"}`.
3. Only then does `run` forward the request, with `x-dozo-relay-channel` (the channel it came on)
   and `x-dozo-relay-agent-proof` (`<ms>.<hex HMAC-SHA-256>` of `relayAgentProofMessage` under the
   key). The key itself never travels, so whatever listens on `--origin` learns nothing it can use
   for long: a proof fits one request kind, one channel and one minute. `run` removes both headers
   from every request a phone sends.
4. The local server answers only a request from this computer with a valid proof; anyone else gets
   404. It gives each channel one session, ever: `200 { token }`, or `409 { reason:
   "sign-in-on-computer" | "one-account" }`, or `410 { reason: "used" }`. With the key set, a
   pairing made on this agent that was not approved within 5 minutes is dropped (its channel
   deleted, `{"event":"expired"}`), and a request still waiting gets `403 { reason: "not-approved"
   }`. A pairing stored before approvals existed is kept, but still asks before a sign-in. An agent
   without the key drops nothing: it never asks. The token crosses only inside the sealed channel
   and is never logged.

"Signed in on the computer" means: the account has a session that is not a phone's, still valid and
used in the last 30 days. It is not proof of who sits at the computer, which is why the approval
above is the real gate.

The session ends:
- when the phone is removed (`revoke --origin`, or `run` when the relay no longer knows the
  channel), and `revoke` says what happened to it: `"session": "revoked" | "unreachable" |
  "skipped"`. "skipped" means `--origin` or the key was not given, so the session was left;
- when the user signs out on the computer (one session or all; a phone session being made at that
  moment is ended too), or when their last computer session ends by any other way (revoked from
  another browser, deleted when found expired);
- when the phone signs out, or the app switches to another server (it signs out of the one it
  leaves, through the relay while the old pairing still answers).

A phone's session may not end other sessions, change or set the password, change the address,
delete the account or ask for that, use the email-code endpoints, or add a passkey or another
sign-in, whether it carries its token as a bearer header or as the session cookie. Those answer 403
and are done on the computer. A removed phone pairs again to get a new session.

Limits, on purpose:
- If the local server cannot be reached when a phone is removed, the session stays in its database.
  The phone still cannot use it: the channel is gone, and the server answers loopback only.
- A computer session that expires without being deleted does not end the phones until it is
  deleted (the server deletes an expired session when it next sees it).
- Anything holding the key can ask for sessions. The key is a secret of the user's own account on
  that computer (a 0600 file); the server checks it, not that the agent knows the channel.
- The "one session per channel" record lives in the `verification` table under a far-future expiry;
  nothing in the server deletes those rows.

The desktop app makes the key with the server's other secrets, gives it to the API
(`DOZO_RELAY_AGENT_KEY`) and to `run`, `approve` and `revoke`, passes `revoke` the server's
`--origin`, and shows the `approval` event to the user.

## Events from `run`

One JSON object per line, for the desktop app to show state:

| Event | Fields | When |
| --- | --- | --- |
| `connected` | `channel` | the relay socket is open |
| `peer` | `channel`, `present` | the phone connected to the relay or went away |
| `paired` | `channel`, `appKey` | the phone's first record opened; the offer is used up |
| `approval` | `channel`, `code`, `platform` | the phone asks for its sign-in; the user approves with `approve` (Phone sign-in) |
| `approved` | `channel` | the user approved the phone |
| `disconnected` | `channel`, `reason`, `retryInMs` | the socket could not open or closed; the next try is in `retryInMs` |
| `refused` | `channel`, `reason` | a session failed its handshake (not the paired phone, expired offer) |
| `revoked` | `channel` | the relay no longer knows the channel (the phone removed it); its keys are gone |
| `expired` | `channel` | an offer ran out unused, or a paired phone was not approved within 5 minutes; its channel is gone |
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
  `{ key, pairingKey, verifierSet, pairedAt, approvedAt }` after pairing. The pairing secret itself is never
  stored.
- `channels/<channel>.approved`: `{ approvedAt }`, written by `approve` only and read back as
  `app.approvedAt`. Kept apart because `run` rewrites the channel's file (pairing, then its
  verifier) from the copy it holds, which must not undo an approval given meanwhile.

One file per channel lets `pair`, `run` and `revoke` work at the same time without a lock. `run`
asks for a phone's approval only once its pairing is in the channel's file, so `approve` finds it. The
storage is one interface (`RelayHostStore`), so the keys can move to the system key store without
touching the rest.

## In the server bundle

`dozo/server-bundle/build.mjs` bundles the command line with esbuild into one file,
`rakazo-server/dozo-relay-agent.mjs` (entrypoint `relay` in the bundle's `manifest.json`), and
checks it answers `list`. The desktop app runs `node dozo-relay-agent.mjs run --origin <web
address> --state <server folder>/relay` beside the server, and `pair`, `list` and `revoke` for
its Connect Phone window (`dozo/desktop/README.md`).

## Local run

In Docker, from a workspace with dependencies installed:

```
pnpm exec tsx packages/adapters/src/dozo-relay-agent.ts pair --relay http://127.0.0.1:8787
```

The dev relay is started from a test or a script with `startDevRelay({ port: 8787 })`.
