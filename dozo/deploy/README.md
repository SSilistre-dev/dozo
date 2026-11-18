# dozo/deploy: one host behind a Dokploy panel

Runs the server side of Dozo (postgres, api, worker, supervisor, web) on a Linux host that a
[Dokploy](https://dokploy.com) panel manages, as a compose service in its own project. It is meant
for a closed pre-release: sign-up is off and nothing but the panel's proxy reaches the stack.

No registry and no Git remote are involved. The branded tree is copied to the host over SSH and
the images are built there, so they match the host's CPU and never leave it.

| File | What it is |
| --- | --- |
| `deploy.sh` | Deploy, roll back, create the owner's account |
| `compose.deploy.yml` | The production layer over upstream's compose file (which stays unedited) |
| `compose.site.yml`, `site.nginx.conf` | The landing page: its own static nginx service (see Landing page) |
| `host-egress.sh` | Run once on the host: firewall rules that keep bot computers off the host and its networks |
| `host-jobs.sh` | Runs on the host: the daily backup, the restore check and the health check, as systemd timers |

## What a deploy does

`dozo/deploy/deploy.sh` deploys the committed tree (`HEAD`; uncommitted changes are left out,
also those to the layer and the theme):

1. `build.sh stage` and `brand` into a temporary stage under your home folder, removed afterwards.
2. Merges upstream's compose file with `compose.deploy.yml` into one file
   (`docker compose config --no-interpolate`, so no secret is needed or written). The run stops if
   that file still builds an image or publishes a port.
3. Copies the staged tree to `<dir>/src` on the host with `rsync` and builds three images there,
   tagged with the commit: `dozo/app` (api, worker, web, migrate; the theme file is added as a last
   layer), `dozo/supervisor` and `rakazo/computer` (the supervisor accepts no other name for the
   stock computer image). `host-jobs.sh` is copied to `<dir>` too.
4. Gives the panel the merged file and sets `DOZO_IMAGE_TAG` in the panel's environment, starts a
   deployment and waits for it.
5. Checks health: on the host, postgres, supervisor, web, api and worker are running, api and
   worker are `healthy`, the app containers and the supervisor run the new tag, the api answers
   `/health` and no service restarts within 15 seconds;
   from outside, `https://<domain>/` answers with a title that names Dozo.
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
```

Your machine needs `git`, `rsync`, `ssh`, `curl`, `jq` and Docker (for the brand step and the
merge). The host needs Docker Engine 26 or newer with Compose 2.24.4 or newer.

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
SIGNUPS_ENABLED=false           # nobody can sign up; accounts come from `deploy.sh owner`
RAKAZO_ADMIN_EMAILS=owner@dozo.example   # who may open /admin (see Admin page)
EMAIL_PROVIDER=none
SANDBOX_COMPUTER_EGRESS=restricted
RAKAZO_COMPUTER_MEMORY=1536m    # per bot computer
RAKAZO_COMPUTER_CPUS=2
SANDBOX_MAX_COMPUTERS_PER_USER=1   # see Bot computers on a shared host
DOZO_STACK_SUBNET=10.213.87.0/24   # optional: the stack's own network, if this range is taken
CLIENT_IP_HEADER=cf-connecting-ip   # only when a CDN that sets this header is in front
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
in the app. Billing is set in test mode only.

`CLIENT_IP_HEADER`: the panel's proxy reports the CDN's address, not the visitor's, so without it
every visitor shares one sign-in rate limit. The header is believed only from the stack's own
networks (the panel's proxy and the web container). Someone who reaches the host directly, past
the CDN, can send it too, which lets them pick the address their own attempts are counted under;
that is the trade against one shared limit anyone can exhaust.

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
  CSP and `X-Frame-Options` come from the app.
- `/api/` and `/rpc/` go to the api container directly. Through the web container a live stream
  stayed open after the API behind it restarted, and open tabs stopped following changes until
  reloaded. While the api container is starting or unhealthy these paths answer 502 (about ten
  seconds after a restart); the app retries by itself.
- `/api/v1/plugin-submissions`, the one write that needs no account, answers 403 to everyone. To
  open it, remove its lines from `compose.deploy.yml`.

## Landing page

`dozo/deploy/deploy.sh site` publishes `dozo/landing/` (committed tree) as a second compose service
in the same panel project: `nginx:1.27-alpine`, content and `site.nginx.conf` mounted read-only from
`<dir>/site`, nothing built. It does not touch the app stack. Compression, cache lifetimes (HTML
5 minutes, CSS and JS 1 hour because they are not hashed, images 30 days), security headers and
the CSP are in `site.nginx.conf`.

One-time setup, in the panel: in the same project create a compose service (type Docker Compose,
source Raw, same server), turn on **Isolated Deployment**, add a domain (service `site`, port `80`,
HTTPS with Let's Encrypt) and point its DNS at the server. Add to the settings file:

```sh
DOKPLOY_SITE_COMPOSE_ID=<id of that compose service>
DOZO_SITE_DOMAIN=site.example
```

The first `deploy.sh site` writes the compose file into the service. To remove: delete the service
in the panel and `<dir>/site` on the host.

## Roll back

A deploy ends with the tag it replaced. `dozo/deploy/deploy.sh rollback <tag>` points the panel at
that tag again and checks health; three tags stay on the host
(`ssh <host> docker images dozo/app`). It restores the code and the theme, not the data: migrations
that ran stay applied, which upstream keeps compatible with the previous release. The compose file
in the panel stays the newest one.

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
- `SANDBOX_MAX_COMPUTERS_PER_USER=1`: the stack's ceilings add up to 4.7 GB and each computer's
  to 1.5 GB more. On a 14 GB host shared with other projects, with its swap full, a second
  computer per user leaves no headroom.
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
  before it is replaced, so a deploy can outlast `DOZO_DEPLOY_TIMEOUT`; the panel still finishes it.
- The build cache on the host grows with each deploy and is shared with the host's other builds, so
  the script does not prune it.
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
backups are in it) and the `dozo/app`, `dozo/supervisor` and `rakazo/computer` images there.
