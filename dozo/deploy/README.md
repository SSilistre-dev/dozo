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
| `host-egress.sh` | Run once on the host: firewall rules that keep bot computers off the host and its networks |

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
   stock computer image).
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
   of at least 16 characters on the host and creates an ordinary verified account. There is no
   password reset without an email provider, so keep the password somewhere safe.

## Environment in the panel

```sh
DOZO_IMAGE_TAG=                 # set by deploy.sh
WEB_ORIGIN=https://dozo.example
BETTER_AUTH_URL=https://dozo.example
API_URL=https://dozo.example
RAKAZO_HOST=dozo.example
SIGNUPS_ENABLED=false           # nobody can sign up; accounts come from `deploy.sh owner`
EMAIL_PROVIDER=none
SANDBOX_COMPUTER_EGRESS=restricted
RAKAZO_COMPUTER_MEMORY=1536m    # per bot computer
RAKAZO_COMPUTER_CPUS=2
SANDBOX_MAX_COMPUTERS_PER_USER=2
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
way. Model keys, sign-in providers, email and billing are deliberately not set: the owner connects
a model in the app.

`CLIENT_IP_HEADER`: the panel's proxy is not on a network the api trusts, so without it every
visitor shares the proxy's address and one sign-in rate limit. The header is believed only from
the web container. Someone who reaches the host directly, past the CDN, can send it too, which
lets them pick the address their own attempts are counted under; that is the trade against one
shared limit anyone can exhaust.

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
panel's "fresh volumes" option, and back up as `docs/self-host-backups.md` describes before
removing anything.

## Bot computers on a shared host

The supervisor holds the Docker socket, which is control of the host, and starts one container per
team computer outside the compose project. What bounds them:

- Each computer runs as a non-root user with every capability dropped, `no-new-privileges`, a
  memory, CPU and process ceiling, its own bridge network, and only its own folder of `dozo_data`
  mounted. It cannot see other projects' volumes.
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
- The public address shows only the web app. The api's `/health` is not routed from outside; the
  deploy checks it inside the container.
- One unauthenticated write stays reachable with sign-up off: plugin submissions
  (`POST /api/v1/plugin-submissions`), rate-limited per address.
- Self-update: upstream's updater sidecar is not part of this compose file, so nothing updates the
  stack but `deploy.sh`.

## Remove

Stop and delete the compose service in the panel (choose whether to delete its volumes), run
`host-egress.sh --remove` on the host, then delete `<dir>` and the `dozo/app`, `dozo/supervisor`
and `rakazo/computer` images there.
