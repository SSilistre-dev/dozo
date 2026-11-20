# Local server bundle

The server a Free user runs on their own computer, without Docker: the API, the worker, the web
server and the migrations, as one archive that runs on plain Node next to a portable Postgres.
The desktop app downloads it on first start; it is not inside the app.

Upstream's `scripts/build-server-bundle.mjs` makes the archive and is not edited. `build.mjs` wraps
it: it runs it on the branded tree, leaves out the packages a local server never loads, repacks and
describes the result. Node and Postgres are not in the archive: `runtimes.json` pins their version,
address and sha256 per platform (Node from nodejs.org, Postgres from the theseus-rs
`postgresql-binaries` releases, which carry `pg_dump` and their own libraries).

| File                                 | What it is                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `build.mjs`                          | Builds the bundle for the machine it runs on from a branded staged tree                 |
| `build.sh`                           | Local linux-x64 build in Docker: stage, brand, then `build.mjs` in `node:24.22-slim`    |
| `manifest.mjs`                       | Joins the built bundles with `runtimes.json` into `manifest.json`                       |
| `runtimes.json`                      | Pinned Node and Postgres downloads                                                      |
| `run.sh`                             | Reference start and stop (Linux, macOS): the start contract below, as a script          |
| `smoke.sh`                           | End-to-end test in a bare Debian container; last line `SERVER-BUNDLE SMOKE: PASS\|FAIL` |
| `fake-model.mjs`, `smoke-client.mjs` | The smoke test's local model and its user                                               |

## Build and test locally

```sh
dozo/server-bundle/build.sh <out>        # <out>/dist/dozo-server-linux-x64.tar.xz and .json
dozo/server-bundle/smoke.sh <out>/dist   # exit 0 pass, 2 fail
```

Both run in Docker with `--cpus 3 --memory 6g` and their own container names; neither touches the
local stack. `build.sh` keeps the pnpm store in the volume `dozo-server-bundle-store`
(`DOZO_PNPM_STORE_VOLUME`); remove it when done.

CI (`.github/workflows/dozo-server-bundle.yml`) builds linux-x64, macOS arm64 and x64 and Windows
x64, and runs the smoke test on linux-x64. Only linux-x64 has to pass. A `server-v*` tag, or a
manual run given a tag, puts the bundles and `manifest.json` on a draft release that is never
marked latest; publishing the draft makes the addresses in the manifest live.

## Manifest

```json
{
  "schema": 1,
  "version": "0.11.0",
  "platforms": {
    "linux-x64": {
      "server": { "url": "…/dozo-server-linux-x64.tar.xz", "sha256": "…", "size": 0 },
      "node": { "version": "24.22.0", "url": "…", "sha256": "…", "size": 0 },
      "postgres": { "version": "16.16.0", "url": "…", "sha256": "…", "size": 0 }
    }
  }
}
```

Platforms: `linux-x64`, `darwin-arm64`, `darwin-x64`, `win-x64`; one is missing when its build
failed. The app reads the manifest of the server version it was built for
(`releases/download/<tag>/manifest.json`), downloads the three parts, checks size and sha256 before
unpacking, and unpacks Node and Postgres one folder down (their archives hold one top folder). The
server archive holds `rakazo-server/`; its `manifest.json` names the four entrypoints.

## Start contract

Everything listens on 127.0.0.1. Secrets are random on first start and kept in a 0600 file in the
user's app folder: the Postgres owner and app passwords, `BETTER_AUTH_SECRET`,
`SCREEN_PROXY_SECRET`, `ENCRYPTION_KEY` and the single-account `RAKAZO_DESKTOP_STACK_TOKEN` (the
first account created is the only one).

1. On Linux, check that `libssl.so.3` exists: Prisma's migration engine loads the system OpenSSL 3.
   Without it, stop with a message that says to install `libssl3`.
2. First start: `initdb -U rakazo -A scram-sha-256 -E UTF8 --locale=C`, then `createdb rakazo`.
3. `pg_ctl start` with `-p <pg port> -c listen_addresses=127.0.0.1 -c unix_socket_directories=`.
4. `migrate`, run to completion, every start (a no-op takes about 1.6 s). Owner role for
   `DATABASE_MIGRATION_URL`; it creates the `rakazo_app` role that `DATABASE_URL` uses.
5. `api`, `worker` and `web` together; ready when the API's `/health` and the web page answer 200.
   The window opens the web address.
6. Stop in reverse: `web`, `worker`, `api` with TERM, then `pg_ctl stop -m fast`.

Each process runs from `rakazo-server/` with only these variables (plus `PATH` and `HOME`):

| Process     | Variables                                                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all         | `NODE_ENV=production`, `RAKAZO_ENV_FILE=none`                                                                                                                                                                                                                                                                               |
| migrate     | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `RAKAZO_DB_PACKAGE_DIR=packages/db`                                                                                                                                                                                                                                               |
| api, worker | `DATABASE_URL`, `DATA_DIR`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `RAKAZO_DESKTOP_STACK_TOKEN`, `BETTER_AUTH_URL` = `WEB_ORIGIN` = `API_URL` = the web address, `SANDBOX_PROVIDER=none`, `CONTENT_ENCRYPTION=off`, `WAKEUP_DRIVER=graphile`, `AGENT_RUNTIME=pi`, `MCP_ALLOW_PRIVATE_ENDPOINT=true` |
| api only    | `API_HOST=127.0.0.1`, `API_PORT`, `AUTH_PASSWORD_ENABLED=true`, `AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false`                                                                                                                                                                                                                |
| web         | `API_PROXY_TARGET` (the API address), `SCREEN_PROXY_SECRET`, `WEB_HOST=127.0.0.1`, `WEB_PORT`, `RAKAZO_DESKTOP_STACK_TOKEN`, `RAKAZO_IMAGE_TAG` (the bundle version)                                                                                                                                                        |

`run.sh` uses ports 54329 (Postgres), 3100 (API) and 5173 (web); the app picks free ones.

## Trimmed packages

`TRIM` in `build.mjs` lists the store folders left out, each with its reason: TypeScript and
Prettier (pulled in by the Prisma CLI, which the migrations need) and the Kubernetes client (loaded
only by that computer provider). That saves about 36 MB unpacked and under 2 MB of download.
Prisma Studio (43 MB) and Prisma's `dev` server stay: the Prisma CLI requires them as it loads, and
`migrate` fails without them. esbuild stays: pages are built with it at runtime. The smoke test is
what proves a trim safe; a name that no longer matches anything is reported in the build log.
