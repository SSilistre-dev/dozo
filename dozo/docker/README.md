# dozo/docker: staged, branded build of the fork

The committed tree is "upstream + new files under `dozo/`". The rename is applied to a throwaway
copy (the stage), so merging upstream never conflicts with branding and the working tree is never
modified. This is the one home for the scripts' commands, variables, exit codes, Docker objects and
what each gate runs. Brand rules and the leak gate: `dozo/brand/README.md`. Merging upstream:
`dozo/SYNC.md`. The browser suite: `dozo/e2e/README.md`.

## Make targets

| Target | Runs |
| --- | --- |
| `make olc` | `gate.sh olc`, the fast gate |
| `make qa` | `gate.sh qa`, the full gate |
| `make stage` | `build.sh stage` |
| `make up` | `build.sh all`: stage, brand, build, up. It stages again every time; `smoke` is not part of it |
| `make down` | `build.sh down`. It cannot pass `--volumes`; call the script for that (see Reset) |
| `make e2e` | `dozo/e2e/run.sh` against a running stack (`make up` first) |
| `make token-kiyas` | `dozo/metrics/token-kiyas.sh`: the offline token benchmark (fixed tasks, real runtime, fake model, no network) against `dozo/metrics/token-baseline.json`; deps read-only from `dozo-qa-deps`; optional `DOZO_TOKEN_PRICING=<file>` |
| `make olcum` | `dozo/metrics/olcum.sh`: code measurement against `dozo/metrics/baseline.json` (`dozo/metrics/README.md`); not part of `olc` or `qa` |

The Makefile exports `DOZO_STAGE_WORKTREE=1` unless it is already set (an empty value turns it off).
`build.sh` with no argument is `all`; an unknown command or argument exits 64.

One run at a time per stage area: every `build.sh` command and `gate.sh qa` take the lock
`<stage>/.lock` (`lock.sh`, shared with `dozo/e2e/run.sh`: a directory holding the owner's pid and
start time read with `LC_ALL=C TZ=UTC`, so a reused pid is not taken for the owner and a viewer in
another time zone or locale does not take a live owner for dead). A second run exits 2 naming the
holder.
The lock of a dead owner (killed with SIGKILL) is taken over under a second `mkdir` mutex, so two
waiting runs start exactly one; a lock with no owner file is given 2 seconds, then taken over. `gate.sh qa` holds it for
all its steps and passes its pid in `DOZO_LOCK_OWNER`, so the `build.sh` steps it starts do not lock
again; `olc` and `unit` do not lock.

## Host requirements

Docker with the Compose v2 plugin, 2.24.4 or newer (`compose.ports.yml` uses `!override` and
`!reset`). Nothing else is installed for you: a missing tool stops the step with exit 2 and its name.
`build.sh` checks, per step:

- `stage`: `git`, `tar`, and `rsync` when `DOZO_STAGE_WORKTREE=1`.
- `brand`: `docker`.
- `build`, `up`, `smoke` generate the env file first: `nc` (a missing one would call a busy port
  free), `openssl`, and the Compose version. `up` and `smoke` also need `curl`.
- `down`: the Compose version, and the staged compose file and `dozo.env` (not a complete stage).

`gate.sh` needs `bash`, `git`, `docker`, and the usual `find`, `awk`, `sed`, `grep`, `cmp`, plus
`pgrep` (qa uses it to stop a step's child processes; without it only the step itself is stopped).
It uses GNU `timeout` or `gtimeout` when present and a built-in watchdog otherwise. Node tooling runs in the
`node:24.22-slim` image (`DOZO_NODE_IMAGE`); there is no host node or pnpm. The one exception is
`dozo/brand/assets/build.sh` (see `dozo/AGENTS.md`).

## build.sh steps

`dozo/docker/build.sh [stage|brand|build|up|smoke|down|all] [--volumes]`. `--volumes` is valid only
with `down`.

1. `stage`: `git archive HEAD` (`DOZO_STAGE_REF` picks another ref) into `dozo/.stage/src.new`. With
   `DOZO_STAGE_WORKTREE=1` it then overlays the files that differ from that ref (`git diff` of the
   ref against the working tree, staged or not) and the untracked-but-not-ignored ones. Every listed
   path is first removed from the copy, whatever it is there, so a deleted or renamed-away file
   disappears and a change of type (file to directory, directory to file, symlink to directory)
   never leaves the old thing in the way or writes through an old symlink. The new tree
   replaces the contents of `src` except `data`, which is never moved (see Generated files). The
   marker `stage.complete` is removed first and written last: a stage cut short has none, and
   later steps refuse it ("run stage"). A stage made before the marker existed needs one
   re-stage.
   - The staged tree has no `.git`, no root `Makefile` and nothing of `dozo/` but `NOTICE` and `LICENSE` (the
     licence of the fork's files): upstream's Dockerfile copies the whole tree before it builds the apps, so an edit to
     fork tooling would otherwise rebuild everything and ship it in the image. The stage tools read
     the real `dozo/` (mounted at `/dozo`), not the stage. The staged `.dockerignore` also lists
     `**/dozo-*.test.*` and the root `README.md` (the fork notice), so editing either does not
     rebuild the images. `stage` reports the number of source files, not counting `src/data`.
   - Local versus CI: the Makefile turns the overlay on, so a local `make qa` tests uncommitted
     files and can pass where CI fails. CI stages HEAD only (it calls `build.sh stage` without the
     overlay). Commit before trusting a local pass.
2. `brand`: in `node:24.22-slim`, as the invoking user, `apply.mjs --root /w --strict`, then the leak
   gate `check.mjs --root /w` (never `--launch`). Either failing exits 2. `--strict` makes a rule
   that already looks applied an error (upstream drift), so a second `brand` on the same stage
   fails: stage again first. Semantics: `dozo/brand/README.md`. A missing tool fails with "brand tool
   missing". `DOZO_SKIP_BRAND=1` skips the step (unbranded build, pipeline testing only).
3. `build`: `docker compose` runs inside the staged copy, project `dozo`, upstream's compose file
   unmodified plus `compose.ports.yml` and `dozo/theme/compose.theme.yml` (the Dozo theme, mounted
   from the checkout's `dozo/theme`; see `dozo/theme/README.md`, Activation). It builds every image, the `computer` sandbox image
   included, one at a time (`COMPOSE_PARALLEL_LIMIT=1`; the Docker VM has about 6 GB). Afterwards it
   prunes dangling images that carry this project's compose label (the base images and other
   projects are untouched), prints the reclaimed space and lists the project's images
   (`[dozo] image: ...`).
4. `up`: `compose up -d`, then waits for `http://127.0.0.1:<port>/` to answer 200, at most
   `DOZO_UP_TIMEOUT` seconds. On timeout it prints `compose ps` and fails.
5. `smoke`: reads the web port from `dozo.env` (read only; it never rewrites the file) and requires the
   file. The web root answers 200, has a `<title>`, and (unless `DOZO_SKIP_BRAND=1`) the title
   contains "dozo" and does not contain "rakazo". Then the `api` container must be `healthy` and the
   `worker` container healthy (running, if it has no healthcheck), waiting at most
   `DOZO_SMOKE_TIMEOUT` seconds each (`starting` keeps waiting). A stopped, missing or unhealthy
   one fails at once with its last 20 log lines. Because that status can be 30 s old, smoke then
   asks again, now: the api's `/health` must answer and the worker's `dist/health-check.js` must pass.
6. `down`: `compose down`. Containers go; the named volumes (`postgres`, `pgdata`, `webassets`,
   prefixed `dozo_`) stay unless `--volumes`. Compose runs from the staged copy, so it needs the
   staged compose file and `dozo.env`; a whole tree is not required, so a stage cut short that still
   has both can be taken down. Without them it exits 2: stage again first.

`all` is steps 1 to 4. Bot computer containers are started by the supervisor outside the compose
project; `down` does not remove them.

## Gates (gate.sh)

`dozo/docker/gate.sh olc|qa|unit`, and `gate.sh upstream-edits <base> [tree]`, which prints the
upstream files that differ from commit `<base>` in `[tree]` (default the working tree) and is not a
gate. `sync.sh` shares it for fork health (`dozo/SYNC.md`). Verdict lines: `OLC|QA|UNIT: PASS in
<s>s`, `... FAIL (<failed steps, comma separated>) in <s>s`, and for a run that is not the full gate
`QA: PASS (partial: <what was left out>) in <s>s` (a `DOZO_QA_STEPS` subset, `DOZO_SKIP_BRAND=1`, or
any of `DOZO_STAGE_REF`, `DOZO_UNIT_SRC`, `DOZO_COVERAGE_MIN`, `DOZO_BRAND_COVERAGE_MIN` set).

### olc

Under 30 seconds once the Node image is local. It never installs anything and runs, in order:

- `bash -n` (`sh -n` for a `#!/bin/sh` script) on every `*.sh` under `dozo/`. The e2e `.ts` files
  have no cheap check; only `make e2e` compiles them.
- `node --check` on every `.mjs` under `dozo/`.
- The brand tests with Node's coverage, floor `DOZO_BRAND_COVERAGE_MIN` (default 97 percent) for
  lines, branches and functions, per file and overall. A source module that no test imports never
  appears in the coverage table and fails too. The pinned module list is every `dozo/brand/*.mjs`
  that is not a test or a `*.test-support.mjs` fixture; the count is printed.
- The e2e helper tests: every `dozo/e2e/*.test.mjs` with Node's test runner (the offline model
  stub, the route matching and the coverage verdict in `logic.ts`). `model-stub.test.mjs` must
  exist. `source-available.test.mjs` fails when the landing page or `.github/README.md` calls Dozo
  open source.
- The landing pages (`dozo/landing/**/*.html`) hold no `[[`: a legal page writes a value only the
  owner can supply as `[[NAME]]`, and a page that still has one must not merge.
- The iOS app's config: `dozo/mobile/check-config.test.mjs` brands upstream's `apps/mobile/app.json`
  with the shipped rules in a scratch tree and fails unless it carries the Dozo name and id family
  and nothing of upstream's Expo account, EAS project, update channel, bundle ids or domain. It
  builds nothing; the check on the resolved config is `dozo/mobile/build.sh check`.
- Every anchored brand rule against the repository tree: `apply.mjs --check --allow-git --strict`
  (writes nothing; prints the `hooks:` line).
- The leak gate on a branded copy: the working tree's `apps`, `packages` and `infra` (tracked and
  untracked, not ignored) are branded in a scratch copy inside one container and scanned by
  `check.mjs`, so the old name left in a screen, an e-mail template, a locale catalogue or a prompt
  fails here, not only at `make qa`. About 9 seconds.
- A rules summary line (informational): the number of files under `dozo/`, of `dozo-*` fork files
  inside upstream directories, and of upstream workflow files (`.github/workflows`, not named
  `dozo-*`). A sync that brings a new upstream workflow changes the last number: see `dozo/SYNC.md`.
- The upstream-edit check: no upstream file may differ from the merge base of `HEAD` and
  `upstream-main` (not its tip, which may be ahead after a sync), except the marked notice block at
  the top of the root `README.md` and the three issue forms the fork replaces whole
  (`.github/ISSUE_TEMPLATE/config.yml`, `bug.yml`, `self-host.yml`; exact names, and a deleted one or
  one that names upstream fails). A non-zero count lists the files and fails. The root `Makefile` is
  the fork's own (the stage drops it): a root `Makefile` in the upstream ref fails the check too.
  **A missing `upstream-main` ref fails the gate, locally and in CI; there is no opt-out.** Create
  it once: `git fetch upstream main && git branch upstream-main upstream/main` (the `upstream`
  remote: `dozo/SYNC.md`, Prerequisites). `DOZO_UPSTREAM_REF` names another ref and exists for tests.
- A self-test of `wait_gone` (the exit status of a step that failed at once, of a step cut short by
  a signal, of one that passed), of the coverage-table parsers and of `timed_out` (which exit codes
  count as a timeout), of the allowed set (per issue form: changed passes; deleted, naming upstream
  and its neighbours do not), and `dozo/docker/build.test.sh`, about a second: in a scratch git repository
  under `TMPDIR` and with a fake `docker` it runs the real `build.sh stage` with `DOZO_STAGE_REF` older
  than `HEAD` (file to directory and back, rename, Unicode, space and tab in names, deleted file,
  symlinks, untracked and ignored files) and compares the staged tree with the working tree; checks
  that `dc` unsets every env-file key (also indented and `export` lines, never a comment); checks the
  lock owner's start time across time zones; and checks that the unit step fails on fewer fork test
  files than the committed tree has.

A step that cannot run fails: no `.mjs` files, no brand tests, no `apply.mjs`, no model-stub test, no mobile config test, no
merge base, a missing Node image (in CI, where `CI` is set, it pulls the image; locally the message
is `docker pull node:24.22-slim`). Nothing is skipped silently.

### unit

Runs every `dozo-*.test.ts(x)` under `apps/`, `packages/` and `infra/` of the branded staged tree
(`DOZO_UNIT_SRC` names another tree and skips the `stage.complete` check) with Vitest in
`node:24.22-slim`. V8 coverage covers only the fork's own `dozo-*.ts(x)` files, with a per-file floor
`DOZO_COVERAGE_MIN` (default 90 percent) for lines, branches and functions. Fewer
test files than the committed tree has (counted with `git ls-tree` on `DOZO_STAGE_REF` or `HEAD`,
never a fixed number) fails, so a deleted test is noticed; commit the deletion when it is meant. A
committed tree with none fails too. The coverage provider is installed inside the
container only. Dependencies live in the Docker volume `dozo-qa-deps` (pnpm store, corepack, one
`node_modules`, reinstalled in place when the lockfile changes); a cold run installs everything, an
unchanged lockfile skips that. `docker volume rm dozo-qa-deps` starts cold. Nothing is written to the
host. The database client (`packages/db/src/generated`) is generated in the volume before every
run, because api tests load `@rakazo/db`. A failing run prints each file under the floor with its number.

### qa

`make qa` runs `olc`, `stage`, `brand`, `unit`, `build`, `up`, `smoke`, then `down`. The terminal
gets `[qa] >> <step> (timeout <s>s, log <path>)` and `[qa] << <step> ok|FAIL|TIMEOUT <s>s` per step,
the last 40 log lines of a failed step, and the verdict. The first failing step stops the run. Each
step's full output is in `dozo/.stage/logs/<step>.log` (git-ignored). `e2e` is not part of it.

- Timeout per step: `DOZO_TIMEOUT_<STEP>` seconds (`<STEP>` upper case: `OLC`, `STAGE`, `BRAND`,
  `UNIT`, `BUILD`, `UP`, `SMOKE`, `DOWN`). Defaults: build 2400, unit 900, the rest 600. A step over
  its limit is killed and fails (exit 124, or 137 once past the limit when the step ignored TERM and was
  killed; both shown as TIMEOUT). `up` itself waits
  `DOZO_UP_TIMEOUT` (default 240).
- If project `dozo` was already running, qa updates it but does not take it down. Otherwise `down`
  runs after the steps, also after a failure, and on an interrupt.
- `DOZO_STOP_TIMEOUT` is the container stop timeout for `up` and `down`; qa sets 60 unless set,
  because upstream gives the worker a 50 minute grace period. Called directly, `build.sh` keeps the
  Compose value unless the variable is set.
- `DOZO_QA_STEPS="olc stage brand unit"` runs a subset in the order given.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOZO_STAGE_DIR` | `dozo/.stage` | Moves the whole stage area (src, env file, logs). Absolute, or relative to the directory you run from |
| `DOZO_STAGE_REF` | `HEAD` | Ref `stage` exports; also the tree whose fork test files `unit` counts. Makes a verdict partial when set |
| `DOZO_STAGE_WORKTREE` | `1` from make, off from the script | Overlay uncommitted and untracked files on the export |
| `DOZO_SKIP_BRAND` | off | `1` skips `brand` and the title check; the build is unbranded and a `qa` verdict says partial |
| `DOZO_NODE_IMAGE` | `node:24.22-slim` | Image for every Node step, including the e2e model stub |
| `DOZO_WEB_PORT` | `5173` | First port tried when the env file has none. A seed only (see Generated files) |
| `DOZO_UP_TIMEOUT` | `240` | Seconds `up` waits for the web app |
| `DOZO_SMOKE_TIMEOUT` | `150` | Seconds `smoke` waits for the api, then for the worker, to be healthy |
| `DOZO_STOP_TIMEOUT` | unset; qa sets `60` | Seconds for `up` and `down` to stop containers |
| `DOZO_QA_STEPS` | all steps | Subset of qa steps |
| `DOZO_TIMEOUT_<STEP>` | build 2400, unit 900, else 600 | Per-step qa timeout in seconds |
| `DOZO_TIMEOUT_BIN` | `timeout`, else `gtimeout`, else none | Timeout command for qa steps; set to an empty string to force the built-in watchdog |
| `DOZO_UNIT_SRC` | `<stage>/src` | Tree `unit` tests. Makes a verdict partial when set |
| `DOZO_COVERAGE_MIN` | `90` | Web unit floor, per file, for the fork's `dozo-*` files |
| `DOZO_BRAND_COVERAGE_MIN` | `97` | Brand floor in `olc`, per file and overall (separate so the web floor is unaffected) |
| `DOZO_UPSTREAM_REF` | `upstream-main` | Ref of the upstream-edit check; tests only |
| `CI` | unset | When set, `olc` and `unit` pull a missing Node image instead of failing |

`sync.sh` runs the gates with `DOZO_QA_STEPS`, `DOZO_SKIP_BRAND` and `DOZO_UPSTREAM_REF` unset. The
e2e variables are in `dozo/e2e/README.md`; the sync ones in `dozo/SYNC.md`.

## Exit codes

- `build.sh`: 0 ok; 2 any failure (the failing step is printed), including a missing host tool and an
  interrupt (SIGINT or SIGTERM exits 2 after cleanup); 64 usage error (`--help` included).
- `gate.sh`: 0 pass; 2 any failed gate; 64 usage error; 130 or 143 when interrupted by SIGINT or
  SIGTERM (it stops the running step, takes down a stack that qa started and removes its
  containers). `upstream-edits` exits 0, 2 when git cannot compute it, 64 without `<base>`.
- Convention for every gate: exit 2 on failure, never weaken a gate to get green (`dozo/AGENTS.md`).

## Docker objects

- Containers started by the scripts use `--init`, are named `dozo-<kind>-<pid>` and carry the label
  `dozo.run=<build|gate|e2e>-<pid>`; the script removes them on exit and on SIGINT or SIGTERM.
  Compose containers are `dozo-<service>-1` (the e2e suite finds the api one by its compose labels).
- Images: `dozo-<service>` for the app images. The sandbox image stays `rakazo/computer:local`: its
  name is hard-coded upstream and the leak gate allows it as an identifier shape.
- Volumes: `dozo-qa-deps` (unit dependencies), `dozo-e2e-npm` (e2e), and the project's `dozo_*`
  volumes. Do not stop or remove what you did not create.

## Generated files

The stage area is `dozo/.stage/` (git-ignored): `src/`, `dozo.env`, `stage.complete`, `logs/`,
`.lock/` while a run is active, and `src.new/` while a stage runs.

- `dozo.env`: random secrets from `openssl rand -hex` (`POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`,
  `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`), mode 600,
  created once and kept across restages. Without `openssl` the step stops and writes nothing; an
  existing file with an empty or missing secret is refused with the fix (see Reset). It also holds
  `RAKAZO_WEB_BIND` (rewritten on every run), the web port and origin keys (`DOZO_WEB_PORT`, `WEB_ORIGIN`, `BETTER_AUTH_URL`,
  `RAKAZO_EXTRA_AUTH_ORIGINS`) and `MCP_ALLOW_PRIVATE_ENDPOINT=true` (added to existing files too):
  the stack binds to 127.0.0.1 on your own machine, so a local OpenAI-compatible endpoint is
  allowed. When it names no admin it gets `RAKAZO_ADMIN_EMAILS=admin@dozo-e2e.test`, the account
  `make e2e` signs up and verifies for its admin scenarios (a reserved `.test` address). Never
  commit it.
- The web port: `DOZO_WEB_PORT` in your shell only seeds the first generation (the first free port
  from it; `up` prints the address it ends up answering at). Afterwards the env file is the single source: the port is kept
  while our web container runs, a busy port is replaced by the next free one, and every key the file
  holds is removed from the environment before Compose runs, so an exported value of it is ignored.
  The origin keys follow the port on each run. `dozo/e2e/run.sh` reads the port from this file too.
- `src/data` (compose bind mount `../../data`, the app data) is preserved across restages: `stage`
  replaces the contents of `src` except `data`, so a failed stage cannot lose it. Upstream's
  `data-init` service creates it as root; on Linux `rm -rf dozo/.stage` may need `sudo` for it.
- `compose.ports.yml`: upstream hard-codes web port 5173 (only the bind address is configurable)
  and api port 3100. It moves web to the generated port and stops publishing the api. Nothing else
  is overridden.

## Reset

- Re-stage and keep secrets, database volumes and app data: `make stage` (or `build.sh stage`). Do
  not delete `dozo/.stage/src` by hand: the app data lives inside it as `src/data`, so deleting it
  destroys that data.
- Full reset (new secrets, empty database, empty app data): `dozo/docker/build.sh down --volumes &&
  rm -rf dozo/.stage`. `down` needs only the staged compose file and `dozo.env`, so it also works
  after an interrupted stage that left both. If it exits 2 because one is gone, run `make stage`
  first (it needs no running stack), then reset.

## Known limits

- Builds need network (npm, apt) and several GB of RAM; a killed build means the VM is out of memory.
- Project status, what CI runs and the open first-boot defect: `dozo/README.md`.
