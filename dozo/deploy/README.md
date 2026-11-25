# dozo/deploy: one host behind a Dokploy panel

Runs the server side of Dozo (postgres, api, worker, supervisor, web) on a Linux host that a
[Dokploy](https://dokploy.com) panel manages, as a compose service in its own project. Nothing
but the panel's proxy reaches the stack, and `SIGNUPS_ENABLED` opens or closes sign-up.

No registry and no Git remote are involved. The images are built on the machine that deploys and
sent to the host over SSH, so a build never takes the running app's memory and CPU (see Where the
images are built); `DOZO_DEPLOY_BUILD=host` builds them on the host as before.

| File | What it is |
| --- | --- |
| `deploy.sh` | Deploy, roll back, create the owner's account |
| `bridge.sh` | Runs on the host during a deploy: keeps a copy of the api and web serving while the panel replaces them (see Deploys without a gap) |
| `outage-probe.sh` | Watches the app from outside during a deploy and reports the longest outage |
| `rehearse.sh` | Rehearses a deploy on your machine, behind the panel's proxy, and measures the outage |
| `compose.deploy.yml` | The production layer over upstream's compose file (which stays unedited) |
| `compose.site.yml`, `site.nginx.conf`, `site-assets.sh`, `site-reload.sh` | The landing page: its own static nginx service (see Landing page) |
| `host-egress.sh` | Run once on the host: firewall rules that keep bot computers off the host and its networks |
| `host-jobs.sh` | Runs on the host: the daily backup, the restore check and the health check, as systemd timers |

## What a deploy does

`dozo/deploy/deploy.sh` deploys the committed tree (`HEAD`; uncommitted changes are left out,
also those to the layer and the theme):

1. `build.sh stage` and `brand` into a temporary stage under your home folder, removed afterwards.
2. Merges upstream's compose file with `compose.deploy.yml` into one file
   (`docker compose config --no-interpolate`, so no secret is needed or written). The run stops if
   that file still builds an image or publishes a port.
3. Builds three images on this machine, tagged with the commit: `dozo/app` (api, worker, web,
   migrate; the theme file is added as a last layer), `dozo/supervisor` and `rakazo/computer` (the
   supervisor accepts no other name for the stock computer image). Then takes the deploy lock,
   sends the layers the host lacks and checks the host's image ids against the ones built here
   (Where the images are built). With `DOZO_DEPLOY_BUILD=host` it copies the staged tree to
   `<dir>/src` with `rsync` and builds there instead. `host-jobs.sh` is copied to `<dir>` too.
4. Gives the panel the merged file and sets `DOZO_IMAGE_TAG` in the panel's environment. Starts
   `outage-probe.sh` against the public address, copies the running api and web on the host with
   `bridge.sh up`, starts the panel's deployment and waits for it, then waits until the host has
   retired the copies, which it does once api and web are healthy again (Deploys without a gap).
5. Checks health: on the host, postgres, supervisor, web, api and worker are running, api and
   worker are `healthy`, the app containers and the supervisor run the new tag, the api answers
   `/health` and no service restarts within 15 seconds;
   from outside, `https://<domain>/` answers with a title that names Dozo, and `/dozo-boot.js`
   still carries the server's `cache-control: no-cache` (a CDN that sets its own browser cache time
   fails this; on Cloudflare: Caching, Browser Cache TTL, Respect Existing Headers).
   Last, it prints what the probe saw and `WARNING: from outside, the app was down for <n>s` when
   the longest outage passed `DOZO_DEPLOY_OUTAGE_WARN` seconds (default 5). That never fails the
   deploy.
6. Removes older tags of the three images, keeping the new one, the one it replaced and the
   newest other one.

It prints `DEPLOY: PASS (...)` and exits 0, or `FAIL: ...` and exits 2 (64 for a usage error). A
deploy of a commit whose images are already on the host builds nothing and restarts nothing.

## Settings

`deploy.sh` reads `~/.config/dozo/deploy.conf` (`DOZO_DEPLOY_CONF` names another file). It is a
shell file that is not in the repository:

```sh
DOZO_DEPLOY_SSH=<ssh host or alias, logging in as a user that may run docker>
DOZO_DEPLOY_DOMAIN=dozo.example
DOKPLOY_URL=https://panel.example
DOKPLOY_COMPOSE_ID=<id of the compose service in the panel>
DOKPLOY_API_KEY_CMD='<command that prints the panel API key>'   # or export DOKPLOY_API_KEY
DOZO_DEPLOY_DIR=/opt/dozo        # optional, the folder on the host
DOZO_DEPLOY_TIMEOUT=900          # optional, seconds to wait for the panel and for health
DOZO_DEPLOY_OUTAGE_WARN=5        # optional, seconds of outage seen from outside before a warning
# optional, the image build's limits (Build limit): DOZO_DEPLOY_BUILD_LIMIT=on|off,
# DOZO_DEPLOY_BUILD_MEMORY_HIGH=4G, DOZO_DEPLOY_BUILD_MEMORY_MAX=6G,
# DOZO_DEPLOY_BUILD_CPU_WEIGHT=20, DOZO_DEPLOY_BUILD_IO_WEIGHT=20
DOZO_DEPLOY_BUILD=local          # optional: local (default) builds here; host builds on the host
```

Your machine needs `git`, `rsync`, `ssh`, `curl`, `jq`, Docker (for the brand step, the merge and
the build) and `zstd`; with the default build it must have the host's CPU (Where the images are
built). The host needs Docker Engine 26 or newer with Compose 2.24.4 or newer, `curl` and `jq` (for
`bridge.sh`), and `zstd` for the default build.

## First-time setup

1. In the panel, create a project and in it a compose service of type Docker Compose with source
   "Raw", on the server that should run it. Turn on **Isolated Deployment** (the stack gets its own
   network that only the panel's proxy joins) and leave isolated volumes off. Add a domain to it:
   service `web`, port `5173`, HTTPS with Let's Encrypt. Point the domain's DNS at that server.
2. Put the environment below into the compose service's environment in the panel. Generate the six
   secrets on the host so they never touch your machine's disk:

   ```sh
   ssh <host> 'for k in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY \
     SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN; do printf "%s=%s\n" "$k" "$(openssl rand -hex 32)"; done'
   ```

3. Write the settings file (above) and run `dozo/deploy/deploy.sh`.
4. Before anyone uses a bot computer, install the firewall rules on the host, as root:
   `ssh <host> 'bash -s' < dozo/deploy/host-egress.sh`. With `SANDBOX_COMPUTER_EGRESS=restricted`
   a computer refuses to start until they are in place.
5. Create the owner's account: `dozo/deploy/deploy.sh owner`. It asks for an email and a password
   of at least 16 characters on the host and creates an ordinary verified account. Both answers can
   be piped in instead, one per line, so a generated password never shows on a screen or in a
   command line. There is no password reset without an email provider, so keep it somewhere safe.
6. Turn on the backup and the health check, as root: `ssh <host> <dir>/host-jobs.sh install` (see
   Backups and Health check).

## Environment in the panel

```sh
DOZO_IMAGE_TAG=                 # set by deploy.sh
WEB_ORIGIN=https://dozo.example
BETTER_AUTH_URL=https://dozo.example
API_URL=https://dozo.example
RAKAZO_HOST=dozo.example
SIGNUPS_ENABLED=true            # false: nobody can sign up; accounts come from `deploy.sh owner`
RAKAZO_ADMIN_EMAILS=owner@dozo.example   # who may open /admin (see Admin page)
EMAIL_PROVIDER=none
SANDBOX_COMPUTER_EGRESS=restricted
RAKAZO_COMPUTER_SIZES=standard=2:1.5,large=2:2,xlarge=4:4   # per plan: see Bot computers on a shared host
RAKAZO_COMPUTER_MEMORY=1536m    # a computer whose plan has no size above
RAKAZO_COMPUTER_CPUS=2
RAKAZO_COMPUTER_MEMORY_TOTAL=6g   # most memory the running computers may hold together; 0: no limit
SANDBOX_MAX_COMPUTERS_PER_USER=2   # see Bot computers on a shared host
RAKAZO_COMPUTER_NETWORK_RANGE=10.214.0.0/16   # optional: the range computer networks are cut from
DOZO_STACK_SUBNET=10.213.87.0/24   # optional: the stack's own network, if this range is taken
CLIENT_IP_HEADER=cf-connecting-ip   # only when a CDN that sets this header is in front
TRUSTED_PROXIES=dokploy-traefik   # with CLIENT_IP_HEADER: the panel's proxy only (Client addresses)
DOZO_ORIGIN_SOURCE_RANGE=       # optional: the CDN's ranges, comma-separated (Origin behind a CDN)
DOZO_PLUGIN_SUBMISSIONS=closed  # optional, the default; open lets anyone submit a plugin
DOZO_FEEDBACK_EMAIL=           # optional: the inbox in-app feedback is mailed to (needs email)
POSTGRES_PASSWORD=...           # the six secrets from step 2
POSTGRES_APP_PASSWORD=...
BETTER_AUTH_SECRET=...
ENCRYPTION_KEY=...
SCREEN_PROXY_SECRET=...
SANDBOX_SUPERVISOR_TOKEN=...
```

Keep `ENCRYPTION_KEY` and the two database passwords for the life of the data: stored credentials
are encrypted with the first, and Postgres takes its passwords only when its volume is first
created. Every other upstream setting (`docs/self-host-configuration.md`) can be added the same
way. Model keys, sign-in providers and email are deliberately not set: the owner connects a model
in the app. Billing is live on the hosted version.

Mobile app ids (optional; each is left out until the owner has it). Without them the server
answers 404 for the association files and the app offers no passkey, as today:

```sh
PASSKEY_APPLE_APP_IDS=<TEAM_ID>.dev.ssilistre.dozo   # serves /.well-known/apple-app-site-association
PASSKEY_ANDROID_CERT_SHA256=<AA:BB:...>             # the release signing key's SHA-256; serves assetlinks.json
APNS_VOIP_KEY_ID=...            # incoming-call pushes: an APNs key of the owner's Apple team
APNS_VOIP_TEAM_ID=...
APNS_VOIP_PRIVATE_KEY=...       # the .p8 file's text, newlines as \n
APNS_VOIP_ENVIRONMENT=production   # sandbox for a development build
```

The Android package in `assetlinks.json` and the push topic are the app's id, `dev.ssilistre.dozo`
(the brand overlay's one definition); `APNS_VOIP_BUNDLE_ID` overrides the topic only for another
build. `dozo/mobile/baglanti-testi.sh <url>` checks what the app asks of a server, these files
included.

### Client addresses

`CLIENT_IP_HEADER`: the panel's proxy reports the CDN's address, not the visitor's, so without it
every visitor shares one sign-in rate limit. The api believes the header only from the proxies in
`TRUSTED_PROXIES`. Unset, those are the stack's own networks, which hold the web container as well
as the panel's proxy; set it to the panel's proxy alone, so a request that reaches the api through
the web container counts under that container's address. Requests from browsers reach the api
through the panel's proxy (What the proxy does), so they keep their own address.

The value is the proxy's container name, which the api resolves on the stack's network every 30
seconds: `dokploy-traefik` on a standard panel install. Check it before setting it, on the host:

```sh
docker ps --format '{{.Names}}' | grep -i traefik            # the proxy's container name
api=$(docker ps -q -f label=com.docker.compose.service=api | head -1)
docker exec "$api" getent hosts dokploy-traefik             # an address in DOZO_STACK_SUBNET
```

If `getent` prints nothing, the name is wrong or the proxy is not on the stack's network; leave
`TRUSTED_PROXIES` unset then, since a proxy the api cannot find is not believed and every visitor
would share one limit again. After the deploy, sign in from two networks; each new session carries
that network's address, not one shared address:

```sh
pg=$(docker ps -q -f label=com.docker.compose.service=postgres | head -1)
docker exec "$pg" psql -U rakazo -d rakazo -c 'select "ipAddress", "createdAt" from session order by "createdAt" desc limit 2'
```

### Origin behind a CDN

`DOZO_ORIGIN_SOURCE_RANGE` limits the routers in `compose.deploy.yml` to these source addresses
(comma-separated IPs or CIDR ranges); anything else gets 403 from the proxy. Unset, everyone is let
in, as before. Set it to the CDN's published ranges, IPv4 and IPv6, and only when every request
comes through the CDN: the health check and `deploy.sh` reach the app by its public name, so they
pass through the CDN too. Keep the list current when the CDN publishes new ranges. To check, after
the deploy: the site loads as before, and a request to the host's own address that skips the CDN
answers 403 (`curl -sk -o /dev/null -w '%{http_code}' --resolve dozo.example:443:<host IP>
https://dozo.example/`).

### Turning on hosted login

The hosted server can sign people in on their own computer's Dozo server with the account they
have here (`packages/auth/src/dozo-hosted-login.ts`). It is off until the api has a signing key;
the panel variable reaches the api and nothing else (`compose.deploy.yml`, held by
`compose.deploy.test.sh`). Every step below was run against a hosted server and computers' servers
made from the server bundle, with a real browser (`dozo/e2e/hosted-login`).

1. Make an Ed25519 key on a trusted machine and keep the output only in the panel's secret store
   (PKCS#8, base64 on one line; the api also takes it as PEM):
   `openssl genpkey -algorithm ed25519 -outform DER | base64 -w0`
2. In the panel's environment of the compose service, add `HOSTED_LOGIN_SIGNING_KEY=<that line>`,
   then `dozo/deploy/deploy.sh` (or redeploy from the panel: only the environment changed).
3. Check from outside, through the CDN:
   - `curl -s https://dozo.example/api/auth/dozo/hosted-login/keys` lists one key
     (`"kty":"OKP","crv":"Ed25519"`). It answers GET only (a HEAD, so `curl -I`, gets 404), with
     `cache-control: no-store`, as every `/api/auth` reply has (`apps/api/src/app.ts`): no CDN
     keeps a copy, and each computer keeps the keys in memory. A CDN in front must pass this path
     through (no challenge page, no rewrite): every computer reads the keys from it.
   - `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'origin: https://dozo.example'
     -H 'content-type: application/json' -d '{}' https://dozo.example/api/auth/dozo/hosted-login/issue`
     answers `401` (no session); `404` means the key did not reach the api.
   - `https://dozo.example/dozo/hosted-login?audience=x&return=y` opens the sign-in page when
     signed out.
4. `WEB_ORIGIN` must be exactly the origin computers are configured with (`HOSTED_LOGIN_ISSUER`,
   built into the desktop app): it is the token's issuer and the one origin the confirmation page
   accepts a request from. A second name for the site, or a trailing path, fails every sign-in. The
   web origin must also answer `/api` (it does here: the proxy sends `/api/` to the api).
5. The desktop app turns it on only when built with the issuer: set the repository variable
   (`gh variable set DOZO_HOSTED_LOGIN_ISSUER --body https://dozo.example`) before tagging a
   desktop release. A build that names it ignores the environment (`dozo/desktop/README.md`).

Changing the key, with no sign-in failing:

1. Make a new key as above. Set it as `HOSTED_LOGIN_OVERLAP_KEY` (published, not used to sign)
   and deploy. Nothing caches the keys, so the next step can follow once `/keys` lists both.
2. Swap: the new key in `HOSTED_LOGIN_SIGNING_KEY`, the old one in `HOSTED_LOGIN_OVERLAP_KEY`.
   Deploy. Tokens signed by the old key in the last minute still check out, and a computer reads
   the keys again the first time a token names one it does not know.
3. After a few minutes remove `HOSTED_LOGIN_OVERLAP_KEY` and deploy.

A leaked key: skip the overlap. Put a new key in `HOSTED_LOGIN_SIGNING_KEY`, remove the overlap
variable and deploy at once; computers pick the new key up on their next sign-in.

To watch: the reason a computer refused a token (`Hosted login refused: <reason>`) is logged on
the computer, not here. Here, watch the rate of `/api/auth/dozo/hosted-login/issue` answers (200
versus 4xx) in the api's request log and `/keys` errors at the CDN.

To turn it off: remove `HOSTED_LOGIN_SIGNING_KEY` (and any overlap key) and deploy. `/keys` and
`/issue` then answer 404, and computers' sign-in fails with "Could not continue" until it is back;
people already signed in on a computer stay signed in (sessions there last 90 days, renewed by
use). Turn the desktop variable off too (`gh variable delete DOZO_HOSTED_LOGIN_ISSUER`) so the
next release is built without it.

## Admin page

`/admin`, in the web app: the accounts (search, suspend, restore), the bot computers that are
running (stop) and whether sign-up is open. It links to upstream's `/admin/access` and
`/admin/plugins`.

- An admin is an account whose address is in `RAKAZO_ADMIN_EMAILS` (comma-separated; case does not matter)
  and is verified. `deploy.sh owner` creates a verified account. Set the variable in the panel and
  redeploy; there is no admin without it.
- Anyone else, signed in or not, gets the page an unknown address shows, and the api answers 403.
- Suspending is upstream's account deactivation (`User.deactivatedAt`; the same as
  `node dist/cli/account-status.js deactivate <email>` in the api container): sign-in is refused,
  open sessions and paired devices end, running work is cancelled and nothing new starts. The
  account also leaves other people's Spaces, and restoring does not put it back. Its computer
  stops when its work has ended and the idle time has passed, or at once with Stop.
- Stop is the app's own Stop: it saves the computer first and refuses while another bot is still
  working on it.

## What the proxy does

The panel adds one router for the domain, to the web container. `compose.deploy.yml` adds its own
beside it as labels. They need the panel's HTTPS entry point to be named `websecure`, its default,
and apply to the host in `RAKAZO_HOST` only, so that must be the domain the panel routes:

- `Strict-Transport-Security` and `X-Content-Type-Options` on every response, and `noindex` plus
  `Referrer-Policy: no-referrer` on shared pages (`/p/`), as upstream's own proxy sets them. The
  app's other pages and assets send `Referrer-Policy: strict-origin-when-cross-origin`. The CSP
  and `X-Frame-Options` come from the app.
- `/api/` and `/rpc/` go to the api container directly. Through the web container a live stream
  stayed open after the API behind it restarted, and open tabs stopped following changes until
  reloaded. While no api container is healthy these paths answer 502 instead of reaching the web
  container; a deploy keeps one healthy (Deploys without a gap), so this happens only when the
  api is down for another reason.
- `/api/v1/plugin-submissions`, the one write that needs no account, answers 403 to everyone,
  from the proxy and from the api itself (`DOZO_PLUGIN_SUBMISSIONS=closed`, the default here). To
  open it, set that to `open` and remove the proxy's lines from `compose.deploy.yml`.
- With `DOZO_ORIGIN_SOURCE_RANGE` set, only those addresses reach the app (Origin behind a CDN).

## Landing page

`dozo/deploy/deploy.sh site` publishes `dozo/landing/` (committed tree) as a second compose service
in the same panel project: `nginx:1.27-alpine`, content and `site.nginx.conf` mounted read-only from
`<dir>/site`, nothing built. It does not touch the app stack. Compression, cache lifetimes (HTML
5 minutes, CSS and JS 1 hour, images 30 days), security headers and the CSP are in
`site.nginx.conf`.

A CDN in front may keep a stylesheet longer than the origin asks, which would pair a new page with
the old CSS. So `site-assets.sh stamp` versions every local asset address in the published copy by
content (`landing.css?v=<first 10 hex digits of its SHA-256>`); the committed pages carry no
version. After the deploy, `site-assets.sh verify` reads the live page and fails unless it names
those addresses and each one serves the bytes that were published.

The panel does not restart a container whose compose file is unchanged, so each publish runs
`nginx -t` and a reload in the running container (`site-reload.sh`) and then `site-assets.sh lang`
fails unless the live site sets and follows the language cookie.

One-time setup, in the panel: in the same project create a compose service (type Docker Compose,
source Raw, same server), turn on **Isolated Deployment**, add a domain (service `site`, port `80`,
HTTPS with Let's Encrypt) and point its DNS at the server. Add to the settings file:

```sh
DOKPLOY_SITE_COMPOSE_ID=<id of that compose service>
DOZO_SITE_DOMAIN=site.example
```

The first `deploy.sh site` writes the compose file into the service. To remove: delete the service
in the panel and `<dir>/site` on the host.

## Deploys without a gap

The panel deploys with `docker compose up -d`, which first stops every container whose image
changed (api, web, worker, supervisor) and only then starts the new ones: the api after the
migrations, the worker after the api is healthy, and the proxy routes to a container only once it
passes its health check. That left nothing to route to for most of the deploy: the live access
log of 21 November showed 502s, then 404s with no router at all, then 502s again, from 3 to 29
seconds after the panel started (up to 58 seconds before a request got through again), and the
panel takes 31 to 42 seconds per deploy. An owner's tap on an approval card in that window was
lost. Compose has no "start the new one first" for a service that is not in a swarm, and the
panel runs Compose, so `deploy.sh` keeps the previous release serving around it with `bridge.sh`
(copied to `<dir>` and run there):

- `bridge.sh up` copies the running api and web into `<project>-bridge-api` and
  `<project>-bridge-web`: same image, environment, volumes, networks and proxy labels, no Compose
  labels (so Compose neither replaces nor removes them), restarting with Docker as the originals
  do. The proxy merges services of the same name, so each copy joins its service. Migrations
  already have to work with the previous release (root `AGENTS.md`), which is all the copies are.
- Then it takes the originals out of the proxy and stops them itself, before the panel starts.
  A container leaves the proxy only by failing its health check: one that just stops is still
  routed to for the second or two the proxy takes to apply the event, and a request sent to its
  address in that moment hangs (about 20 seconds in the rehearsal) instead of being refused. So the
  api and web checks fail while `/dev/shm/dozo-drain` exists (`bridge.sh` creates it; a new start
  clears it), and they run every 5 seconds with 3 retries, so a marked container is out within
  15 to 20 seconds. That, with the api's 30 seconds to finish its requests, is what this adds to
  a deploy.
- The panel then replaces them as before; the proxy routes to the new api and web once they pass
  their checks, which probe every second while starting (upstream's production compose file does
  the same).
- `bridge.sh up` leaves `bridge.sh watch` running on the host, detached from the deploy: it
  retires each copy (out of the proxy the same way, then removed) once its service runs healthy
  in a container that took over from it. If the panel has not replaced an original 15 minutes
  after it stopped (`DOZO_BRIDGE_RESTORE_AFTER`), it starts it again and then retires the copy.
  A deploy that dies before the panel started puts the originals back at once (`bridge.sh
  restore`). Whatever happens to `deploy.sh` (a timeout, Ctrl-C, a dropped connection), the copies
  go away by themselves, and `deploy.sh` waits for that before its health check. Its log:
  `<dir>/bridge.log`.
- Open live streams and device sockets on a stopping api close at once and reconnect
  (`apps/api/src/http/drain.ts`).
- The worker keeps upstream's rule: the old one finishes its running jobs before it stops. Compose
  starts nothing new until it has, so a long job delays the deploy; the copies serve meanwhile and
  `watch` waits up to four hours.

Measured with `rehearse.sh` (same layer and Compose command as the panel, Traefik v3.5.0 on Docker
28.4, `outage-probe.sh` sending each of its four requests every quarter second, 60 seconds allowed
per request). Each run ends with no copy left and api and web healthy.

| Deploy | Requests | Failed | Longest outage | Slowest answer |
| --- | --- | --- | --- | --- |
| Before (`main`'s layer, no copies), two image builds | 601 / 432 | 305 / 138 | 27.2 s / 8.2 s | |
| With this change | 1213 | 0 | 0 s | 0.1 s |
| With this change, the caller gone after the panel started | 1230 | 0 | 0 s | 0.1 s |
| With this change, the panel never deploying | 1131 | 0 | 0 s | 0.1 s |
| The first deploy of this change (from `main`'s layer) | 801 | 46 | 8.0 s | 7.2 s |

The first deploy still has originals whose check ignores the marker, so the panel stops them
while routed: about half of the API requests got 502 for the eight seconds the old api took to
stop. The proxy labels do not change in this change, so nothing else differs from later deploys.
`deploy.sh` prints the probe's lines at the end of every deploy (from outside it sends about two
requests a second); compare them with these.

Memory: the copies hold what the originals did (about 0.5 GB for the api and 0.2 GB for web on the
live host; 0.3 and 0.2 GB in the rehearsal) while the new ones start, for about a minute; the live
host had about 8 GB available.

When something is left over (placeholders: `<dir>`, `<project>` is the panel's project name, as
in `docker ps`):

```sh
ssh <host> tail -n 50 <dir>/bridge.log                      # what bridge.sh did
# Copies still serving (`docker ps -f name=bridge`): let them retire once api and web are healthy,
ssh <host> 'nohup <dir>/bridge.sh watch <project> >/dev/null 2>&1 &'
# Originals stopped and no deploy coming: start them now (the copies retire once they are healthy)
ssh <host> <dir>/bridge.sh restore <project>
# The marker left in a running api or web (it stays out of the proxy):
ssh <host> 'docker exec <container> rm -f /dev/shm/dozo-drain'
# Last resort, with the api and web of the stack running healthy:
ssh <host> docker rm -f <project>-bridge-api <project>-bridge-web
```

Known limits:

- The api and web leave the proxy after three failed checks 5 seconds apart, where upstream's
  checks allow twenty 10 seconds apart. With one api, a hung api fails requests either way; the
  shorter count only drops it sooner.
- Two api processes run for that minute, as when upstream runs several. A Telegram bot set by
  environment variable without a webhook (`TELEGRAM_BOT_TOKEN`) is polled by one process at a
  time, so the other logs conflicts until the copy is gone; the live host sets none.
- A host restart during a deploy brings the copies back (they restart with Docker) but not
  `watch`: start it as above.
- The supervisor still restarts with every deploy (its image changes): starting or controlling a
  bot computer fails for those seconds.
- To rehearse: `flock -w 7200 /tmp/dozo-yigin.lock dozo/deploy/rehearse.sh <running layer> <new
  layer> plain|bridge|abandon|abort` (the running layer of `main`: `git show
  main:dozo/deploy/compose.deploy.yml`). On Docker 29 or newer the proxy cannot read the daemon;
  set `DOCKER_HOST` to a `docker:28.4.0-dind` that mounts the work folder at the same path,
  `DOCKER_SOCKET` to its socket and `DOZO_REHEARSAL_BIND=0.0.0.0` with its port 18443 published.

## Deploy lock

`deploy`, `rollback` and `site` take a lock on the host (`$DOZO_DEPLOY_DIR/.deploy.lock`, a symbolic
link holding a random run id, the action and commit, and the start time), so two machines cannot
deploy to the same host at once. A second run prints one line and waits for the first, polling
every few seconds; the lock is freed on any exit, including Ctrl-C and `kill` (not `kill -9`).
`owner` takes none. A deploy takes it after staging and branding, and with the default build after
building the images on this machine, all of which change nothing on the host; with
`DOZO_DEPLOY_BUILD=host` that is before the tree is copied. Two deploys can stage and build at once;
their copies, sends and switches take turns. The lock is labelled `deploy-<commit>`, the first nine
characters of the staged commit (before, the short form of whatever `HEAD` was then). A failing ssh
call is tried again up to 3 times.

Under the lock, before anything on the host changes, a deploy reads the commit the panel runs now
(`DOZO_IMAGE_TAG`) and stops unless the commit being deployed contains it: a deploy that finished
building later must not put an older or another line of work over a newer release. Nothing running
(a first deploy) and the same commit pass. A running commit this checkout does not know (not
fetched) stops the run too, and a panel that does not answer stops it before anything changes.
`rollback <tag>` is the way back on purpose and is not checked.

- `DOZO_DEPLOY_LOCK_WAIT`: seconds to wait for a running deploy (default 1800); 0 fails at once.
- `DOZO_DEPLOY_LOCK_STALE`: seconds after which a lock is taken as left behind and broken
  (default 7200; keep it above the longest deploy, a build and the panel's waits included).

Both must be whole numbers (else exit 64). A lock whose content cannot be read is never broken:
the run times out and says so. A run killed with `kill -9` or a lost connection leaves its lock
until the stale limit; remove it with `ssh <host> rm $DOZO_DEPLOY_DIR/.deploy.lock` when no deploy
is running. Stale locks are broken under a second link (`.deploy.lock.break`, one holder, a leftover
older than a minute is removed); the one remaining window is a breaker stalled for over a minute
or an owner releasing in the instant a stale lock is removed.

## Where the images are built

By default (`DOZO_DEPLOY_BUILD=local`) the images are built on the machine that runs `deploy.sh`:

1. One read-only call asks the host for its platform, its image store, the room in Docker's folder
   and the layers of every `dozo/app`, `dozo/supervisor` and `rakazo/computer` it holds. If all
   three images of the commit are there, nothing is built or sent.
2. The three images are built here with `--platform` set to the host's, without the deploy lock,
   so a long build does not hold the host. They carry the labels `dozo.deploy.build=local` and
   `dozo.deploy.input=<digest>`, the digest of every file of the staged, branded tree and the theme.
   Images of the commit left here by an earlier run (a failed send) are used again only when that
   digest is the same; a tree branded differently for the same commit is built again.
3. The lock is taken. `docker save` writes the three images to the stage, and every layer file is
   left out whose layers, up to and including it, the host already has under some image: a host
   with the classic image store reads a layer file only when that chain is missing. What remains
   is packed with `zstd` and piped over ssh into `zstd -d | docker load`; nothing is stored on the
   host but what `docker load` keeps.
4. The host's image ids must equal the config digests in the archive (in the classic store an
   image's id is its config's digest) and its layers the archive's, for exactly the three images.
   Any difference removes the three tags of the commit from the host again and stops the run
   before anything is replaced.

A tag of the commit on the host therefore comes only from a build there or from a load whose ids
were checked: `docker load` tags an image after all its layers are in, each checked against its
digest, so a half or damaged load leaves no tag, and a failed check takes the tags away. That is
why step 1 trusts a tag it finds, and asks again under the lock in step 3: if another deploy's
cleanup removed the images since, the run stops (deploy again).

A failure on this side never touches the running app: a failed build, a connection that drops, a
damaged archive, a failed load or a failed check leaves no tag of the commit on the host (the next
run sends again; a partial load leaves only layers, which the next load reuses). A host whose
Docker folder has less room than the archive plus its layers unpacked (an estimate: four times the
packed size, plus 1 GiB) is refused before anything is sent. If a later Docker on the host refuses
an archive without the layers it has, every send fails the same way; the message says so, and
`DOZO_DEPLOY_BUILD=host` is the way out (there is no automatic retry with every layer: a cut
connection would send twice as much for nothing). The run also
stops before building when the host has another CPU than this machine, keeps its images in
containerd's store (where leaving layers out is untested), or either side lacks `zstd`; each says
to set `DOZO_DEPLOY_BUILD=host`. A bad value of `DOZO_DEPLOY_BUILD` exits 64 before any ssh.

Here, the tags of this script's images older than the three newest commits are removed after each
build (only twelve-digit tags with its label; no other image, no volume, no prune). The build cache
on this machine grows like the host's and is not pruned either. The host's build cache is no longer
refreshed meanwhile, so going back to `DOZO_DEPLOY_BUILD=host` after a while is a cold build there
(up to about 19 minutes, with the host's load that brings).

### First deploy on this path: what to watch

In order: `build the images here (linux/amd64)`, `built in <n>s`, `host: sending <n> MiB (<n> MiB
before packing; <n> layers are there already)` (the first time almost nothing is there: the host's
own builds share no layers with this machine's), `host: packed, sent and loaded in <n>s`, `host: the
ids of the three images match the ones built here`, then the usual bridge, panel and health lines.
The probe's `slowest` and `longest outage` lines are the measure: with no build on the host they
should stay near a deploy without one (under a second). On any `FAIL` before `panel: deploying`,
check on the host that the api and web containers were not replaced (`docker ps` shows the old
tag and start time) and deploy with `DOZO_DEPLOY_BUILD=host` if the cause is on this path.

Deploying from a Mac with Apple silicon: the host runs `linux/amd64`, so the default build stops
before building. Either deploy from a Linux `amd64` machine or set `DOZO_DEPLOY_BUILD=host`.
Building for `amd64` under emulation is not offered: it is far slower and has not been tried for
this stack. Neither path has been run from a Mac.

`dozo/deploy/deploy-ship.test.sh` (in `make olc`) checks all of this with a stub Docker on both
sides. `dozo/deploy/deploy-ship.dind.sh` runs the same code against a real Docker of the host's
version (`DOZO_SHIP_DIND_IMAGE`, default `docker:28.4.0-dind`) as the host; run it when the host's
Docker changes.

## Build limit

Only for `DOZO_DEPLOY_BUILD=host`. The image build shares the host with the running app and can
starve it of memory first and CPU second. Before it builds, the host script starts a systemd slice, `dozobuild.slice` (no dash: systemd
reads a dash as nesting, Docker does not), sets limits on it with `systemctl set-property --runtime`,
reads them back from the slice's cgroup files (`memory.high`, `memory.max`, `memory.swap.max`,
`cpu.weight`, `io.weight`) and, only if they match, passes `--cgroup-parent=dozobuild.slice` to each
`docker build`. Nothing runs when the images of the commit are already on the host.

- `DOZO_DEPLOY_BUILD_MEMORY_HIGH` (default `4G`): the build is throttled and reclaimed inside its own
  group above this. `DOZO_DEPLOY_BUILD_MEMORY_MAX` (default `6G`): a build above it is killed and the
  deploy fails before anything on the host was replaced, saying to raise this setting. Sizes are a
  whole number with an optional `K`, `M` or `G`. Swap is fixed at 0 for the build.
- `DOZO_DEPLOY_BUILD_CPU_WEIGHT` and `DOZO_DEPLOY_BUILD_IO_WEIGHT` (default 20 each, 1 to 10000;
  everything else on the host has 100).
- `DOZO_DEPLOY_BUILD_LIMIT=off` builds as before. A bad value exits 64 before any ssh.

It prints one of two lines, and a failed setup never fails the deploy:

```
[deploy] host: build limited in dozobuild.slice (memory.high ..., memory.max ..., swap.max 0, cpu.weight 20, io.weight 20)
[deploy] host: build NOT limited: <reason>
```

Reasons: turned off; the deploy user is not root; no systemd; no cgroup v2; systemd could not start the
slice or refused the limits; the read-back differed (it prints both). To see a running build inside
the slice, on the host: `systemd-cgls dozobuild.slice`, or `cat /sys/fs/cgroup/dozobuild.slice/*/cgroup.procs`
(the build's containers are the child groups). The limits are runtime-only; each deploy sets them again.

The limit bounds the build's own memory and lowers its priority; it does not bound what the build
reads from disk or the network. It has been checked offline only (stub `systemctl` and `docker`,
`dozo/deploy/deploy-build-limit.test.sh`) until the first real deploy.

## Roll back

A deploy ends with the tag it replaced. `dozo/deploy/deploy.sh rollback <tag>` points the panel at
that tag again and checks health; three tags stay on the host
(`ssh <host> docker images dozo/app`). It restores the code and the theme, not the data: migrations
that ran stay applied, which upstream keeps compatible with the previous release. The compose file
in the panel stays the newest one.

Before going back to a commit without `bridge.sh`, or deploying from the panel by hand, make sure
no copy is left: `ssh <host> docker ps -f name=bridge` shows none, or remove them as above (the
commands under Deploys without a gap). The panel does not know them, and an older `deploy.sh`
would never retire them.

## Data

Four named volumes hold everything and outlive a redeploy, a rollback and `compose down`:
`dozo_postgres` (the database), `dozo_data` (app data and bot computer homes), `dozo_webassets`,
and `dozo_pgdata` (empty; upstream's Postgres 16 upgrade path). Never start a deployment with the
panel's "fresh volumes" option, and take a backup before removing anything.

## Backups

`host-jobs.sh install` (once, as root on the host) enables `dozo-backup.timer`: every day at 03:30
it writes `<dir>/backups/<UTC stamp>/` with `db.dump` (`pg_dump -Fc`), `data.tgz` (the whole
`dozo_data` volume) and `SHA256SUMS`, and keeps the newest seven (`DOZO_BACKUP_KEEP`). Folder and
files are readable by root only. The copies stay on the same host and are not encrypted: a lost
disk loses them with the data, so copy them elsewhere (upstream's way, with `age`:
`docs/self-host-backups.md`).

```sh
ssh <host> <dir>/host-jobs.sh backup            # one now
ssh <host> <dir>/host-jobs.sh verify [folder]   # default: the newest
ssh <host> 'systemctl list-timers "dozo-*"; journalctl -u dozo-backup.service -n 20'
```

`verify` checks the checksums, restores the dump into a throwaway Postgres container with no
network and compares the row count of every table with the live database, which it only reads.
It prints `VERIFY PASS`, or the tables that differ (rows written since the backup do) and exits 1.

To restore, on the host as root, one line at a time: stop at the first one that fails. The
database step is what `verify` exercises; the whole sequence follows upstream's
(`docs/self-host-backups.md`) and has not been rehearsed on a live stack:

```sh
cd <dir>/backups/<stamp> && sha256sum --check SHA256SUMS
p=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' \
  "$(docker ps -q --filter volume=dozo_postgres)")
of() { docker ps -aq -f "label=com.docker.compose.project=$p" -f "label=com.docker.compose.service=$1"; }
bots=$(docker ps -q -f name=rakazo-bot-)
docker stop $(of api) $(of worker) $(of web) $(of supervisor) $bots
DOZO_BACKUP_KEEP=99 <dir>/host-jobs.sh backup   # what you are about to replace; deletes no older one
docker exec -i "$(of postgres)" sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error \
  --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <db.dump
data=$(docker volume inspect -f '{{.Mountpoint}}' dozo_data)
mv "$data" "$data.before-restore" && mkdir "$data"
tar -xzf data.tgz --numeric-owner -C "$data"    # never over the old tree: newer files would stay
docker start $(of supervisor) $(of api) $(of worker) $(of web)
```

If the database step fails nothing has changed: start the services again. Delete
`$data.before-restore` once the restored app checks out.

## Health check

The same `install` enables `dozo-health.timer`: every five minutes it checks that postgres,
supervisor, web, api and worker run and are healthy, that the api answers `/health`, and that the
public address answers with the app's page. A fault is written to the journal as a `FAULT` line
and leaves the unit failed until the next good run. Nobody is notified: look, or point your own alerting at the unit.

```sh
ssh <host> 'systemctl list-units --failed "dozo-*"; journalctl -u dozo-health.service --since -1d --grep FAULT'
ssh <host> <dir>/host-jobs.sh health            # one check now; exit 1 on a fault
```

## Bot computers on a shared host

The supervisor holds the Docker socket, which is control of the host, and starts one container per
team computer outside the compose project. What bounds them:

- Each computer runs as a non-root user with every capability dropped, `no-new-privileges`, a
  memory, CPU and process ceiling, its own bridge network, and only its own folder of `dozo_data`
  mounted. It cannot see other projects' volumes. Its screen port is published on the host's
  loopback address only.
- Every running computer needs a network from Docker's default address pools (31 on a stock
  daemon) and gives it back when it stops. On a host whose other projects hold them all, a
  computer fails to start with a 500 and `all predefined address pools have been fully subnetted`
  in the api log. The stack's own network has a fixed subnet so it takes none; the fix on the host
  is `docker network prune` for networks nothing uses, or more pools (`default-address-pools` in
  the daemon's settings, which needs a Docker restart).
- `RAKAZO_COMPUTER_SIZES` is what each plan's computer gets, as `size=vCPUs:GB`: `large` is
  Premium, `xlarge` is Premium Plus, and `standard` is a computer without a paid plan's size,
  which is not sold here (Free has no hosted computer). The default, set in `compose.deploy.yml`,
  is `standard=2:1.5,large=2:2,xlarge=4:4`. The api and the worker read
  it: Billing shows these numbers and every start sends them to the supervisor, so what is shown
  is what is applied. A stopped computer moves to its plan's size on its next start (an upgrade,
  a downgrade or a changed value); a running one keeps its size until it stops, which it does
  after `SANDBOX_IDLE_MS` without work. Keep vCPUs at or under the host's cores: Docker refuses
  more, and the computer then fails to start with a 500. A malformed value fails Billing and
  every start, naming the variable. List all three sizes: a computer whose size is left out is
  created under `RAKAZO_COMPUTER_CPUS` and `RAKAZO_COMPUTER_MEMORY`, keeps whatever size it last
  had when it restarts, and Billing shows upstream's figure for it. Billing describes computers
  on this host; a bot that uses a person's own machine is not sized.
- `RAKAZO_COMPUTER_MEMORY_TOTAL` is the most memory the running computers may hold together
  (`6g`, in the format of `RAKAZO_COMPUTER_MEMORY`). It counts the memory ceilings of the
  computers that are running plus the ceiling of the one starting, not what they use: a start that
  would pass it is refused before anything is created, the person's run ends with "All computers
  are busy. Try again shortly." and no computer time is charged. The supervisor checks it against
  Docker's own list of running computers, so the figure on the admin page is Docker's, not a
  remembered count, and starts are admitted one at a time so two cannot pass it together. `0`
  means no limit, as before; left out, this layer sets `6g`. A stopped computer holds nothing, so
  idle sleep (`SANDBOX_IDLE_MS`, 10 minutes by default, not set by this layer) is what gives
  memory back to the budget. A computer with no memory ceiling of its own (`RAKAZO_COMPUTER_MEMORY=0`
  and no size for its plan) counts as `RAKAZO_COMPUTER_MEMORY`, and as the whole total when that
  is unlimited too, so nothing else starts beside it; keep a ceiling on every size. A total
  smaller than one plan's computer refuses every start of that plan. A start waits at most 30
  seconds for its turn behind the starts ahead of it, then is refused the same way, so one stuck
  start cannot hold the rest. A malformed total stops the supervisor at startup, naming the
  variable. A computer whose start is refused is left as it was, not marked failed. A watch
  routine whose start is refused tries again a minute later instead of pausing, for as long as the
  routine stays on.
- `RAKAZO_COMPUTER_NETWORK_RANGE` is the IPv4 range computer networks are cut from; this layer
  sets `10.214.0.0/16`. Docker gives a network with no subnet a slot of its default address
  pools, about 31 on a host, shared with every other project there; with the range, each
  computer's network takes a /28 of it instead (4096 in a /16) and no pool slot. The supervisor
  reads the subnets of the networks Docker has and takes the first /28 no network covers, one
  creation at a time. It must not overlap `DOZO_STACK_SUBNET` or another network of the host:
  nothing checks that at startup, the covered part is only skipped. A range with no /28 left
  refuses the start like a full memory total. A range that is not an IPv4 CIDR of /28 or wider
  stops the supervisor at startup, naming the variable. Set it empty to use Docker's pools. A
  network made before the range was set keeps its subnet until its computer next stops.
- `SANDBOX_MAX_COMPUTERS_PER_USER` caps the computers one person's live bots have across all
  their Spaces; this layer sets `2`. It counts computers that exist, running or not, and is
  checked when a bot is made, restored or given its own computer, never at a start. Bots in one
  Space share one computer, kept for the Space's owner, so a member's bot there counts for the
  owner; a bot switched to its own computer is one more. It counts on every plan, Free included.
  At `2` a person has a second Space, or one bot with its own computer, and can hold two
  computers' memory at once: 4 GB of the total on Premium, 8 GB on Premium Plus. At `1` nobody
  holds more than one, and the first bot in a second Space is refused. Past the cap the person
  reads "User computer limit (2) reached". `SANDBOX_MAX_COMPUTERS_PER_SPACE` caps the containers
  of one Space, stopped ones included (the supervisor refuses a new one with 429). Neither counts
  the host; the memory total above does.
- A size is a ceiling, not a reservation, and the total only keeps the ceilings of the running
  computers within it. A computer that passes its own ceiling has a process killed inside it
  (usually a browser tab); the rest of the host is untouched. When everything on the host together
  needs more than the host has, the kernel kills a process anywhere on it, which can be the
  database or another project. The stack's own ceilings add up to 4.7 GB.
- Why 6 GB, from one reading on the host on 2026-11-18 with no bot computer running (a single
  reading, not a guarantee): 14.0 GB total, 7.8 GB available, swap full. The stack held 1.0 GB of
  its 4.7 GB of ceilings, and everything else on the host held about 5.2 GB. So 6 GB fits what the
  host uses today with about 1.8 GB to spare. It does not fit if the stack and the computers all
  reach their ceilings at once, which is about 1.9 GB over; `4g` is the value that holds in that
  case. The live host is to be set to `4g` from the panel, since 6 GB only holds while the stack
  and the computers stay below their ceilings. Set it from a new reading when the other projects
  on the host change, and watch `docker stats` and the kernel log for `oom-kill`.
- `host-egress.sh` installs upstream's restricted-egress rules (public internet only: no host, no
  private or link-local address, so no other container, no published port of the host and no cloud
  metadata) plus one rule for a host on a Tailscale network, where forwarded traffic is accepted
  before Docker's own chain is read. All rules match only the computers' bridges (`rakazo-c*`).
  `--remove` takes them out again.
- The supervisor's control port is reachable only on the stack's network and each computer's own
  bridge, behind `SANDBOX_SUPERVISOR_TOKEN`. That token is what stands between a computer and the
  Docker socket: never reuse or expose it.

## Known limits

- The rules are checked when the supervisor starts its first computer, not continuously: a later
  firewall reload on the host that flushes them goes unnoticed until the supervisor restarts. They
  return on boot (two systemd units).
- A worker that is running jobs is given upstream's grace period (50 minutes) to finish them
  before it is replaced, so a deploy can outlast `DOZO_DEPLOY_TIMEOUT`; the panel still finishes it,
  and the copies of the api and web keep serving until the next deploy retires them.
- The build cache (on the deploying machine, or on the host with `DOZO_DEPLOY_BUILD=host`) grows
  with each deploy and is shared with other builds there, so the script does not prune it.
- The api's `/health` is not routed from outside; the deploy and the health check ask it inside
  the container.
- A host restart has not been rehearsed. The services restart with Docker (`unless-stopped`), and
  the firewall units and the two timers are enabled.
- The computer's terminal (`computer.terminalUrl`, which the web app does not offer) returns a
  session whose socket the computer closes at once; the screen and taking control work.
- Self-update: upstream's updater sidecar is not part of this compose file, so nothing updates the
  stack but `deploy.sh`.

## Remove

Stop and delete the compose service in the panel (choose whether to delete its volumes), run
`host-egress.sh --remove` and `<dir>/host-jobs.sh remove` on the host, then delete `<dir>` (the
backups are in it) and the `dozo/app`, `dozo/supervisor` and `rakazo/computer` images there (and on
the deploying machine, those labelled `dozo.deploy.build=local`).
