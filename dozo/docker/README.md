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

5. `unit` (qa only, between `brand` and `build`): `dozo/docker/gate.sh unit` runs every
   `dozo-*.test.ts(x)` under `apps/` and `packages/` of the branded staged tree with Vitest in a
   `node:24-slim` container, with V8 coverage limited to the fork's own `dozo-*.ts(x)` files and a
   per-file floor of 90% for lines, branches and functions (`DOZO_COVERAGE_MIN` overrides). The
   coverage provider is installed inside the container only. Dependencies live in the Docker volume
   `dozo-qa-deps-<lockfile checksum>` (pnpm store, corepack download, `node_modules`): a cold run
   takes about 80 s, a run with an unchanged lockfile about 5 s. Nothing is written to the host.
   Exit 2 when a test fails, a file is under the floor (the file and number are printed), or fewer
   than `DOZO_MIN_FORK_TESTS` (default 3) files are found. `make olc` never installs; it runs
   `node --check` and the brand tests (same 90% floor, Node's built-in coverage) in the same image
   and fails, never skips, when the image is missing: in CI (`CI` set) it pulls it, locally it says
   `docker pull node:24-slim`.

## Commands
`dozo/docker/build.sh [stage|brand|build|up|smoke|down|all]` (`all` = stage, brand, build, up).
`make olc` fast gate (<30 s, offline), `make qa` full gate, `make stage|up|down`.
Exit codes: 0 ok, 2 any failure (the failing step is printed), 64 usage error.

## qa, unattended
`make qa` runs olc, stage, brand, unit, build, up, smoke, down. The terminal gets a start and an end
line per step with elapsed seconds, the last 40 log lines of a failed step, and a final
`QA: PASS in <s>s` or `QA: FAIL (<steps>) in <s>s`. The full output of each step is in
`dozo/.stage/logs/<step>.log` (git-ignored). Each step has a timeout, `DOZO_TIMEOUT_<STEP>` seconds
(build 2400, unit 900, others 600), after which it is killed and fails. If project `dozo` was already
running when qa started, qa rebuilds and updates it but does not take it down. `up` and `down` use
`DOZO_STOP_TIMEOUT` (qa sets 60) as the container stop timeout, because upstream gives the worker a
50 minute grace period: recreating or stopping a worker that is still draining jobs would otherwise
hold the step for up to 50 minutes. Called directly, `build.sh` keeps the compose value unless that
variable is set. `DOZO_QA_STEPS="olc stage brand unit"` runs a subset (nothing is taken down if
`up` is not in it); `DOZO_STAGE_DIR=<absolute path>` moves the whole stage area (src, env, logs).

## Generated files
- `dozo/.stage/dozo.env`: random secrets (`openssl rand -hex`), mode 600, ignored by git. Created
  once and kept across restages. Also holds `DOZO_WEB_PORT`, the origin variables and
  `MCP_ALLOW_PRIVATE_ENDPOINT=true` (added to existing files too, secrets untouched): our stack
  binds to 127.0.0.1 on the user's own machine, so a local OpenAI-compatible model endpoint is
  allowed. Upstream's compose passes it to `api` and `worker` through `x-app-environment`. Never commit it.
- `dozo/.stage/src/data` (compose bind mount `../../data`) is preserved across restages: `stage`
  builds the new tree in `dozo/.stage/src.new` and replaces the contents of `src` except `data`,
  which is never moved, so a failed stage cannot lose it. Upstream's `data-init` service creates
  `data` as root; on Linux `rm -rf dozo/.stage` may need `sudo` for that directory.
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
