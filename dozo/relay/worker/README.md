# Relay Worker

The relay of [`dozo/relay/PROTOCOL.md`](../PROTOCOL.md) on Cloudflare Workers, sized for the free
plan. A phone and the user's computer each open one WebSocket here; the relay pairs the two and
copies sealed records across. It never sees a key that opens them.

- One Durable Object per channel (`Channel`, SQLite-backed: the only kind the free plan has). It
  stores the verifiers and timestamps of `PROTOCOL.md`, nothing else.
- Sockets use the hibernation API and `ping` is answered by the runtime itself, so an idle channel
  costs no duration. Storage is written on register, pairing and delete, and at most once a day
  when an end connects (to know when a channel went idle).
- `Registry`, one object for the whole relay, counts channels against `MAX_CHANNELS`, holds the
  per-source limits on registration and keeps daily counters. It is asked on register, pairing and
  delete only.
- The protocol's types and constants are not copied: Wrangler bundles them from
  `packages/contracts` and `packages/core` (the `alias` block in `wrangler.jsonc`).
- Registration has one pluggable step, `Admission` in `src/admission.ts`. The default admits
  everyone; a deployment that ties channels to an account checks the request there.

## Limits

Every refusal is an empty `404` (unknown channel, wrong token, refused registration); `400` for a
body that does not parse; `429` with `Retry-After: 60` when a limit is hit.

| Limit | Where | Default |
| --- | --- | --- |
| Registrations per client address | `REGISTER_LIMIT` | 30 a minute |
| Channel requests per client address (connect, pair, delete) | `ACCESS_LIMIT` | 120 a minute |
| Requests one channel answers: with a right token, and apart from those with a wrong one | `CHANNEL_ATTEMPTS_PER_MINUTE` | 60 a minute each |
| Messages and bytes one channel carries | `CHANNEL_MESSAGES_PER_MINUTE`, `CHANNEL_BYTES_PER_MINUTE` | 3000, 128 MiB a minute (socket closed with `1008`) |
| Unpaired channels one source holds at once | `PENDING_PER_SOURCE` | 10 (`0`: none) |
| Live channels one source registered in the last day | `CHANNELS_PER_SOURCE_PER_DAY` | 30 (`0`: none) |
| Channels that exist at once | `MAX_CHANNELS` | 10000 (`0`: none); see below |
| Message size | `RELAY_MAX_MESSAGE_BYTES` | 65,561 bytes (`1009`) |
| Sockets per channel | protocol | one per role; a new one replaces the old (`4000`) |
| Unpaired channel | protocol | deleted 2 minutes after the offer expires (`4001`) |
| Idle paired channel | `IDLE_DAYS` | deleted after 180 days without a connection (90 at least) |

The per-address limits use the rate limiting binding, which counts per Cloudflare location, not
globally. The per-channel counters live in the object's memory and start again when it hibernates.

### Registration without an account

Registering needs no account, so local installs can pair a phone and anyone can run their own
relay. What keeps a few addresses from using the relay up:

- A source is the registering IPv4 address or the /64 of an IPv6 address. The registry keeps it
  only as a keyed hash (the key never leaves it) and forgets it a day after registration. Each
  source may hold `PENDING_PER_SOURCE` unpaired channels at once and have registered
  `CHANNELS_PER_SOURCE_PER_DAY` channels in the last day that still exist, paired or not; the
  second limit is what stops a source from filling the ceiling with channels it pairs itself.
- At `MAX_CHANNELS`, the oldest unpaired channel makes room for the new one. A paired channel is
  never pushed out, so a flood of registrations cannot reach anyone's phone. A pushed-out channel
  cannot be paired: the host's `PUT` gets `404`, as for a deleted channel, and the channel goes.
- Only when every channel is paired does the ceiling refuse with `429`.

Known limit: someone with many IPv6 /64s (a /48 has 65,536) counts as many sources. They can then
fill the ceiling with self-paired channels, which keeps new phones from pairing until the operator
raises `MAX_CHANNELS` or the channels go idle; phones already paired keep working. The counters
below show it happening.

A proof of work at registration was considered and not built: the host computes in JavaScript
(about 125,000 SHA-256 a second on one core, measured with WebCrypto in Node 24), while the same
machine's native hashing through Node's own API already does about 817,000. A difficulty a slow
computer solves in under a second costs a native attacker milliseconds, and the old registration of
desktop 0.3.0 and 0.4.0 would have had to stay open beside it anyway.

### Counters

`GET /admin/stats` with `Authorization: Bearer <ADMIN_TOKEN>` answers the number of channels, the
unpaired ones among them, and per UTC day (last 14): registered, paired, pushed out (`evicted`),
and refused for each limit (`refusedPending`, `refusedDaily`, `refusedCeiling`). No address, channel
id or token. Registrations refused by the per-address rate limit are not counted, because counting
them would cost a Durable Object request each. Without the secret, or with one shorter than 32
characters, the path answers `404` like any other refusal. Logs stay off.

```sh
openssl rand -base64 36 | npx wrangler secret put ADMIN_TOKEN    # once, from dozo/relay/worker
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://relay.example.com/admin/stats
```

## Develop and test

Everything runs in Docker through `docker.sh` (the repository is mounted, because the protocol
comes from `packages/`):

```sh
dozo/relay/worker/docker.sh npm ci
dozo/relay/worker/docker.sh npm test          # Workers runtime, offline
dozo/relay/worker/docker.sh npm run typecheck
dozo/relay/worker/docker.sh npx wrangler deploy --dry-run --outdir /tmp/out
```

The tests run in the local Workers runtime with `@cloudflare/vitest-plugin`: the HTTP and socket
contract, the limits, expiry, revocation, reconnects, hibernation (eviction with sockets kept), and
one end-to-end run of the real sealed channel and multiplexer through the relay.

## Deploy

Needs a Cloudflare account (the free plan is enough) and an API token with the "Edit Cloudflare
Workers" template. Pass it as `CLOUDFLARE_API_TOKEN`, never as a file in the repository.

```sh
dozo/relay/worker/docker.sh npm ci
CLOUDFLARE_API_TOKEN=<token> dozo/relay/worker/docker.sh npx wrangler deploy
```

The first deploy answers on `https://dozo-relay.<account>.workers.dev`; put that address in the
host's relay setting. For your own domain, the zone must be on the same account: add
`"routes": [{ "pattern": "relay.example.com", "custom_domain": true }]` to `wrangler.jsonc` (the
hosted relay uses `relay.dozo.bot`) and deploy again. Set `workers_dev` to `false` once the domain
works if the workers.dev address should stop answering.

Running your own: change `name`, give each `ratelimits` entry a `namespace_id` unused in your
account, and adjust `vars`. The relay must be served over https (`PROTOCOL.md`, Threat model).

## Free plan budget

What counts against the free plan, what the documentation leaves open (whether runtime-answered
`ping` messages count as requests), and how to measure it on a deployed relay:
[`QUOTA.md`](QUOTA.md).

From the message counts measured over the live relay (about 1,200 messages and 25 upgrades per
active user-day), Durable Object requests run out first: at about 1,150 active users a day if the
pings do not count, about 380 if they do. Duration and rows written are not a constraint.
