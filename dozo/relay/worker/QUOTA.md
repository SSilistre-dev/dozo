# Relay on the free plan: what counts, and how to measure it

What the Cloudflare documentation says (read 2026-11-21), what it leaves open, and the
measurements that settle it on a deployed relay. The capacity estimate in `README.md` depends on it.

## What the documentation says

[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/):

- Free plan, daily, reset at 00:00 UTC: 100,000 requests, 13,000 GB-s of duration, 5 million rows
  read, 100,000 rows written. "If you exceed any one of the free tier limits, further operations of
  that type will fail with an error."
- Requests include "HTTP requests, RPC sessions, WebSocket messages, and alarm invocations". Every
  RPC method call on a stub is one request. Each `setAlarm()` is one row written.
- Footnote 2: "There is no charge for outgoing WebSocket messages, nor for incoming WebSocket
  protocol pings." Incoming messages are billed at 20:1. "The 20:1 ratio does not affect Durable
  Object metrics and analytics, which reflect actual usage."
- Footnote 3, on duration: "Application level auto-response messages handled by
  `state.setWebSocketAutoResponse()` will not incur additional wall-clock time, and so they will not
  be charged."

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 100,000 Worker
requests a day on the free plan; past it a Worker answers Error 1027.

[Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
counts per Cloudflare location, not worldwide. The page names no plan restriction.

[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/):
5 GB of Durable Object storage per free account, 1 GB per SQLite-backed object on the free plan.

## What it leaves open

The ends send a text `ping` that the relay answers with `setWebSocketAutoResponse`. That is an
application-level message, not a protocol ping frame, so the footnote 2 exemption does not name
it. Footnote 3 rules out duration for it but says nothing about requests. So it is still open
whether each such `ping` counts as an incoming message (1/20 of a request). It decides the
capacity estimate: a computer connected all day sends about 3,456 pings, so about 173 requests a
day if they count, or none if they do not. With the message counts measured in M1 (about 1,200
messages and 25 upgrades per active user-day), that is about 260 requests per user-day (about
380 users a day) or about 85 (about 1,150 users a day).

It is also open whether the free plan's 100,000-request limit is applied to the 20:1 billed count
or to the actual message count that analytics shows.

## Measurement plan

Run on a separate Worker, so neither live traffic nor the nightly canary is mixed into the counts.

1. Deploy a copy under its own name. In a scratch copy of `wrangler.jsonc`, set
   `"name": "dozo-relay-quota"` and give the two `ratelimits` entries unused `namespace_id`s
   (for example `4201` and `4202`), then:

   ```sh
   cd dozo/relay/worker
   npx wrangler deploy --config wrangler.quota.jsonc
   ```

2. Pair one computer through it: point a local server's relay setting at
   `https://dozo-relay-quota.<account>.workers.dev`, show the QR code, pair a phone, and leave the
   computer running with the agent connected for 24 hours. Close the phone app, so only the
   computer's socket and its pings remain. Write down the start time in UTC.

3. Read the counts. The token needs Account Analytics: Read. First list the fields, because the
   dataset fields are only documented through introspection:

   ```sh
   curl -s https://api.cloudflare.com/client/v4/graphql \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"query":"{ __type(name: \"AccountDurableObjectsInvocationsAdaptiveGroupsSum\") { fields { name } } }"}'
   curl -s https://api.cloudflare.com/client/v4/graphql \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"query":"{ __type(name: \"AccountDurableObjectsPeriodicGroupsSum\") { fields { name } } }"}'
   ```

   Then the hourly counts for the test Worker (adjust the field names to what introspection
   listed; `requests` and `cpuTime` are the ones the documentation shows):

   ```sh
   cat > /tmp/quota.json <<'EOF'
   {"query":"query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
     invocations: durableObjectsInvocationsAdaptiveGroups(limit:100,
       filter:{datetimeHour_geq:$s,datetimeHour_lt:$e,scriptName:\"dozo-relay-quota\"},
       orderBy:[datetimeHour_ASC]){dimensions{datetimeHour} sum{requests}}
     periodic: durableObjectsPeriodicGroups(limit:100,
       filter:{datetimeHour_geq:$s,datetimeHour_lt:$e},
       orderBy:[datetimeHour_ASC]){dimensions{datetimeHour namespaceId} sum{cpuTime}}
     workers: workersInvocationsAdaptive(limit:100,
       filter:{datetimeHour_geq:$s,datetimeHour_lt:$e,scriptName:\"dozo-relay-quota\"},
       orderBy:[datetimeHour_ASC]){dimensions{datetimeHour} sum{requests}}}}}",
    "variables":{"a":"<account id>","s":"<start>T00:00:00Z","e":"<end>T00:00:00Z"}}
   EOF
   curl -s https://api.cloudflare.com/client/v4/graphql \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data @/tmp/quota.json
   ```

   Wrangler has no command for Durable Object usage; the dashboard's Durable Objects page
   (Metrics tab) and the account's Billing, Usage page show the same and the billed numbers.

4. Read the result. With hibernation, incoming messages are counted in
   `durableObjectsInvocationsAdaptiveGroups` (per the
   [metrics page](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)).
   An idle hour has about 144 pings from the computer:

   - about 144 requests per idle hour there: auto-responded pings are counted as incoming
     messages. Then the Billing, Usage page tells whether the free limit sees 144 or about 7.
   - near zero per idle hour: they are not counted, and the higher estimate holds.

5. Delete the test Worker: `npx wrangler delete --name dozo-relay-quota`.

If pings do count, the computer's end can send WebSocket protocol ping frames instead of the text
`ping` where its socket client allows it (Node's does; a phone's React Native socket cannot), which
footnote 2 exempts. That is a change to the ends and the protocol, not made here.

## Abuse and the daily quota

Each registration costs about four Durable Object requests (the registry, the channel, its alarm,
the release) and a few rows written; a refused one costs one registry request. The per-source limits
(`README.md`, Limits) stop one source from holding the channel ceiling, and unpaired channels can
no longer keep anyone from pairing. They cannot stop a flood of plain requests from using up the
daily Worker or Durable Object quota: any request that reaches the Worker counts, and one that
reaches a channel counts twice. Against that, the zone's WAF rate limiting rules (available on the
free plan, counted per IP, matched on path) stop requests before the Worker runs. Whether requests
blocked there are left out of the Workers quota is to be checked on the dashboard, like the pings.
