# Relay Worker

The relay of [`dozo/relay/PROTOCOL.md`](../PROTOCOL.md) on Cloudflare Workers, sized for the free
plan. A phone and the user's computer each open one WebSocket here; the relay pairs the two and
copies sealed records across. It never sees a key that opens them.

- One Durable Object per channel (`Channel`, SQLite-backed: the only kind the free plan has). It
  stores the verifiers and timestamps of `PROTOCOL.md`, nothing else.
- Sockets use the hibernation API and `ping` is answered by the runtime itself, so an idle channel
  costs no duration. Storage is written on register, pairing and delete, and at most once a day
  when an end connects (to know when a channel went idle).
- `Registry`, one object for the whole relay, counts channels against `MAX_CHANNELS`. It is asked
  on register and delete only.
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
| Channels that exist at once | `MAX_CHANNELS` | 10000 (`0`: none) |
| Message size | `RELAY_MAX_MESSAGE_BYTES` | 65,561 bytes (`1009`) |
| Sockets per channel | protocol | one per role; a new one replaces the old (`4000`) |
| Unpaired channel | protocol | deleted 2 minutes after the offer expires (`4001`) |
| Idle paired channel | `IDLE_DAYS` | deleted after 180 days without a connection (90 at least) |

The per-address limits use the rate limiting binding, which counts per Cloudflare location, not
globally. The per-channel counters live in the object's memory and start again when it hibernates.

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

Free plan, daily: 100,000 Worker requests, 100,000 Durable Object requests, 13,000 GB-s of
duration, 100,000 SQLite rows written. Incoming WebSocket messages count as one request per 20;
outgoing ones are free; a WebSocket upgrade is one request.

An estimate for one active user-day, not a measurement. Assumed: the phone connects 20 times, the
computer 5 times; 300 requests through the tunnel, about 2,000 incoming messages with handshakes
and flow control; each handled message keeps the object busy for about 5 ms.

| | Per user-day | Users the free plan holds |
| --- | --- | --- |
| Worker requests (upgrades, pairing) | about 25 | about 4,000 |
| Durable Object requests (25 upgrades + 2,000 / 20 messages) | about 125 | about 800 |
| Duration (2,000 × 5 ms × 128 MB) | about 1.3 GB-s | about 10,000 |
| Rows written | about 2 | not a constraint |

So Durable Object requests run out first, at several hundred active users a day. Message count
decides it; bytes barely matter.

Not verifiable on the free plan from the documentation, check on a deployed relay:

- Whether runtime-answered `ping` messages count as requests. If they do, a computer connected all
  day adds about 3,456 / 20 ≈ 170 requests, which roughly halves the users above.
- Whether the rate limiting binding is offered on the free plan (its page does not say).
- The per-object storage limit on the free plan (the limits page and its FAQ disagree); the relay
  stores a few hundred bytes per channel either way.
