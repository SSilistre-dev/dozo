# dozo/docker: staged, branded build of the fork

The committed tree is "upstream + new files under `dozo/`". The rename is applied to a throwaway
copy, so merging upstream never conflicts with branding and the working tree is never modified.

## Flow
1. `stage`: `git archive HEAD` (no `.git`) into `dozo/.stage/src`. `DOZO_STAGE_WORKTREE=1` also
   overlays uncommitted and untracked-but-not-ignored files (needed until `dozo/` is committed;
   the Makefile sets it by default). `DOZO_STAGE_REF=<ref>` picks another ref.
2. `brand`: in `node:24-slim`, `dozo/brand/apply.mjs --root <stage>` then the leak gate
   `dozo/brand/check.mjs`. Exit 2 on either failure. If the tool is missing the step fails with
   "brand tool missing"; `DOZO_SKIP_BRAND=1` skips it (unbranded, pipeline testing only).
3. `build`: `docker compose` runs inside the staged copy with upstream's compose file unmodified,
   project `dozo`. Builds the `computer` sandbox image first (what `pnpm sandbox:build` does),
   then the app images one at a time (`COMPOSE_PARALLEL_LIMIT=1`, the Docker VM has ~6 GB).
4. `up`: starts the stack, waits for the web app to answer 200. `smoke`: checks HTTP 200 and that
   `<title>` is branded (not checked with `DOZO_SKIP_BRAND=1`). `down [--volumes]`: removes
   containers; volumes (Postgres) are kept unless `--volumes`.

## Commands
`dozo/docker/build.sh [stage|brand|build|up|smoke|down|all]` (`all` = stage, brand, build, up).
`make olc` fast gate (<30 s, offline), `make qa` full gate, `make stage|up|down`.
Exit codes: 0 ok, 2 gate failure, other non-zero for errors; the failing step is printed.

## Generated files
- `dozo/.stage/dozo.env`: random secrets (`openssl rand -hex`), mode 600, ignored by git. Created
  once and kept across restages. Also holds `DOZO_WEB_PORT` and the origin variables. Never commit it.
- `dozo/.stage/src/data` (compose bind mount `../../data`) is preserved across restages.
- `compose.ports.yml`: needed because upstream hard-codes web port 5173 (only the bind address is
  configurable) and api port 3100. It moves web to `DOZO_WEB_PORT` (first free port from 5173,
  printed by the script) and stops publishing the api. Nothing else is overridden.

## Reset
`dozo/docker/build.sh down --volumes && rm -rf dozo/.stage` (new secrets, empty database).
Delete only `dozo/.stage/src` to re-stage but keep secrets and database volumes.

## Known limits
- Image names: `dozo-<service>` for app images (from the project name). The sandbox image name
  (`rakazo/computer:local`) is hard-coded upstream; it only changes if the brand tool rewrites it.
- Bot computer containers are started by the supervisor outside the compose project; `down` does
  not remove them.
- Builds need network (npm, apt) and several GB of RAM; a killed build means the VM is out of memory.
- Port is chosen at `build`/`up` time; the web origin settings are generated for `127.0.0.1:<port>`.
