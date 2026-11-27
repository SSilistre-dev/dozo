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
   Between the two, the fork's own dependencies (`dozo/deps/README.md`) go into the staged manifest
   and lockfile; an empty list starts no container. `DOZO_SKIP_BRAND=1` skips them too.
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
   The api's log must not say `fork job queue did not start` or `fork job queue stopped` (the
   fork's billing jobs; they run only where billing and email are configured).
6. `down`: `compose down`. Containers go; the named volumes (`postgres`, `pgdata`, `webassets`,
   prefixed `dozo_`) stay unless `--volumes`. Compose runs from the staged copy, so it needs the
   staged compose file and `dozo.env`; a whole tree is not required, so a stage cut short that still
   has both can be taken down. Without them it exits 2: stage again first.

`all` is steps 1 to 4. Bot computer containers are started by the supervisor outside the compose
project; `down` does not remove them.

## Gates (gate.sh)

`dozo/docker/gate.sh olc|qa|unit|checks|budget`, and `gate.sh upstream-edits <base> [tree]`, which prints the
upstream files that differ from commit `<base>` in `[tree]` (default the working tree) and is not a
gate. `sync.sh` shares it for fork health (`dozo/SYNC.md`). Verdict lines: `OLC|QA|UNIT|CHECKS|BUDGET: PASS in
<s>s`, `... FAIL (<failed steps, comma separated>) in <s>s`, and for a run that is not the full gate
`QA: PASS (partial: <what was left out>) in <s>s` (a `DOZO_QA_STEPS` subset, `DOZO_SKIP_BRAND=1`, or
any of `DOZO_STAGE_REF`, `DOZO_UNIT_SRC`, `DOZO_COVERAGE_MIN`, `DOZO_BRAND_COVERAGE_MIN` set).

### olc

Under 30 seconds once the Node image is local (about 12 on an idle machine; it took 33 to 125 when
its steps ran one after the other, the deploy lock test alone 12). It never installs anything and runs
the checks below. The independent ones start together, each with its output in a file, and their lines
are printed in the order listed, so the time is that of the slowest check; every check still runs and
a failure in any of them fails the gate:

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
- The fork's dependency step: `dozo/deps/apply.test.mjs`, offline with a fake pnpm, on which
  lockfiles it accepts (upstream's versions and integrity kept, new packages listed).
- Every anchored brand rule against the repository tree: `apply.mjs --check --allow-git --strict`
  (writes nothing; prints the `hooks:` line).
- The leak gate on a branded copy: the working tree's `apps`, `packages` and `infra` (tracked and
  untracked, not ignored) are branded in a scratch copy inside one container and scanned by
  `check.mjs`, so the old name left in a screen, an e-mail template, a locale catalogue or a prompt
  fails here, not only at `make qa`. About 9 seconds. The brand step also gives every id the Turkish catalog has and another lacks
  its English source there, replaced by the fork's translation when `dozo/brand/translations` has one
  (`dozo/brand/catalog-fill.mjs`, run by `apply.mjs`). The same copy must then keep every translation's placeholders,
  tags and ICU branches (`dozo/brand/catalog-translations.mjs`) and hold every id in all 16 catalogs
  (`dozo/brand/catalog-parity.mjs`).
- A rules summary line (informational): the number of files under `dozo/`, of `dozo-*` fork files
  inside upstream directories, and of upstream workflow files (`.github/workflows`, not named
  `dozo-*`).
- The production compose layer (`dozo/deploy/compose.deploy.test.sh`): `docker compose config` of
  upstream's compose file with `compose.deploy.yml`, no daemon and no `.env`, checks what the panel
  gets: `TRUSTED_PROXIES` and `DOZO_PLUGIN_SUBMISSIONS` reach the api (closed by default), every
  router goes through the origin allowlist (everyone unless `DOZO_ORIGIN_SOURCE_RANGE` is set), and
  the app's Referrer-Policy. Needs `docker compose` and `jq`. About a second.
- The upstream workflow list: a workflow file under `.github/workflows`, not named `dozo-*`, that
  `dozo/upstream-workflows.txt` does not list fails the gate, so a sync that brings one stays red
  until it is reviewed (`dozo/SYNC.md`, Upstream's GitHub workflows).
- The upstream-edit check: no upstream file may differ from the merge base of `HEAD` and
  the pristine upstream branch (not its tip, which may be ahead after a sync), except the marked notice block at
  the top of the root `README.md` and the three issue forms the fork replaces whole
  (`.github/ISSUE_TEMPLATE/config.yml`, `bug.yml`, `self-host.yml`; exact names, and a deleted one or
  one that names upstream fails). A non-zero count lists the files and fails. The root `Makefile` is
  the fork's own (the stage drops it): a root `Makefile` in the upstream ref fails the check too.
  The branch is the fresher of local `upstream-main` and `origin/upstream-main` (no fetch): the
  remote one when the local one is behind it, the local one when ahead (a sync not yet pushed), and
  a failure when they diverged. The verdict line names the ref used.
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

A step that cannot run fails: no `.mjs` files, no brand tests, no `apply.mjs`, no model-stub test, no mobile config test, no dependency step test, no
merge base, a missing Node image (in CI, where `CI` is set, it pulls the image; locally the message
is `docker pull node:24.22-slim`). Nothing is skipped silently.

### unit

Runs every `dozo-*.test.ts(x)` under `apps/`, `packages/` and `infra/` of the branded staged tree
(`DOZO_UNIT_SRC` names another tree and skips the `stage.complete` check) with Vitest in
`node:24.22-slim`. V8 coverage covers only the fork's own `dozo-*.ts(x)` files, tests and
`*.test-support.*` fixtures left out (a fixture only a Postgres test loads never runs here), with a per-file floor
`DOZO_COVERAGE_MIN` (default 90 percent) for lines, branches and functions. Fewer
test files than the committed tree has (counted with `git ls-tree` on `DOZO_STAGE_REF` or `HEAD`,
never a fixed number) fails, so a deleted test is noticed; commit the deletion when it is meant. A
committed tree with none fails too. The coverage provider is installed inside the
container only. Dependencies live in the Docker volume `dozo-qa-deps`: the pnpm store and corepack
(`/cache/store`, `/cache/corepack`) are shared by every checkout on the machine, and each staged tree
gets its own working copy with its own `node_modules` in `/cache/trees/<12 hex of sha256 of the
tree's absolute path>` (`unit-tree.sh`; reinstalled in place when the lockfile changes). Two
checkouts can run the unit step at once and each tests its own files; before this, both synced into
one fixed directory, so a run could lose its coverage files or pass on the other branch's sources.
Two `gate.sh unit` runs on the same tree (or one beside a running `make qa`) still share that tree's copy: only `qa` takes the stage lock.
A copy costs about 0.4 GB on top of the one store (about 3 GB), because `node_modules` hard-links
into the store (same volume); a cold run installs everything, an unchanged lockfile skips that.
`docker volume rm dozo-qa-deps` starts cold. Nothing is written to the host.

Cleaning up (nothing here removes anything for you; other sessions may be using the volume): the
directory `/cache/w` is what older versions used and nothing reads it now, and a checkout that is
gone leaves its `/cache/trees/<key>` behind. Each run writes `/cache/trees/<key>.owner` beside the
tree (outside it, since the sync removes what the stage lacks): the staged tree's path on the host.
`dozo/docker/unit-trees.sh` lists every tree with its size and whether its owner is `live` (the
staged tree is still there), `dead` (it is gone) or `unknown` (no note, and not one of this
repository's checkouts), and prints the command that removes each dead one. It mounts the volume
read-only and deletes nothing; run the printed `docker run ... rm -rf /cache/trees/<key>
/cache/trees/<key>.owner` yourself for a tree you know is dead, and
`docker run --rm -v dozo-qa-deps:/cache node:24.22-slim rm -rf /cache/w` for the old directory.

The database client (`packages/db/src/generated`) is generated in the volume before every
run, because api tests load `@rakazo/db`. Before the tests, `tsc --noEmit` checks `apps/api`, `apps/web`, `apps/mobile`, `packages/adapters`, `packages/core`, `packages/contracts`, `packages/db`, `packages/chat-ui` and `packages/ui-web` on the branded tree, one after the other (each timed in the log; the images are bundled, not type-checked, and upstream's own check runs on the unbranded tree only), so a type error there fails the step. Then the module state guard (`dozo/db/module-state-guard.mjs`) and its tests run on the unbranded working tree (mounted read-only), parsing with the TypeScript 6 the lockfile installs for `apps/www`: every long-lived mutable state in the fork's server code (`dozo-*` files), the relay worker (`dozo/relay/worker/src`) and what the anchored brand rules add to upstream files there (module-level `let`/`var`, containers, `new X()`, calls and mutated literals, class fields, factory state a closure reaches, `globalThis` writes) must be a row in `dozo/db/module-state-reviewed.tsv` with where it lives (`module`, `class X`, `fn make`) and its key scope. A new row, a hit that moved to another level, a stale row, or a missing guard, test, list or parser fails the step (exit 2); nothing is fetched. A failing run prints each file under the floor with its number.

### checks

Upstream's `pnpm checks` (`scripts/checks/*.test.mjs`) on the branded staged tree, copied without
`node_modules` into a throwaway git repository (all files added, no commit) in `dozo-checks:<tag>`, the
Node image plus git and the four npm packages two checks load (`yaml` and Lingui, pinned in the
recipe; the tree is not installed, so they are linked in as its `node_modules`), built on first use (three tries, `DOZO_CHECKS_RETRY_PAUSE` seconds apart, default
5) and kept under a tag made of the Node image and the recipe. Only that build needs the network, so a run
on a machine that has the image no longer fails on a DNS hiccup; a fresh CI runner builds it once per
run. It runs in `qa` and in the CI job `dozo-gate` after `brand`, not in `olc`, which stays offline.

The same step then runs `lingui extract` in the copy and holds the Turkish catalog to `dozo/brand/catalog-turkish.mjs`:
an entry whose translation is empty or the English source, unless its id is in
`dozo/brand/catalog-turkish-same.json` (the words and technical terms Turkish keeps in English), is
either the fork's or upstream's. It is upstream's when every source file it names is in the pristine
upstream tree (`upstream-main`) and no anchored brand rule wrote its text; anything else, and every
entry when the ref is missing, is the fork's. The fork's fails (`TURKISH: FAIL`): translate it in a
brand rule on the Turkish catalog, or list a term that reads the same in Turkish. Upstream's never
fails: each is printed as `pending: "<id>"` and counted in `TURKISH: PASS (... N upstream ids pending translation)`,
so a daily sync merges by itself. On a sync pull request, `dozo-gate` writes the pending ids into the one open issue
labeled `turkish-queue` (closed when none are left). Translate them in the same brand rule when someone gets to it.

### budget

The web startup budget: upstream's `scripts/checks/bundle-size.mjs` and its limit in
`scripts/checks/bundle-size.budgets.json` (never raised by the fork), on the branded web build. It
runs `node` in an image built from the staged tree, `dozo-web` by default (what `build` just made;
`DOZO_BUDGET_IMAGE` names another), which carries that tree's check, budgets file and
`apps/web/dist`. Only `dozo/docker/web-budget.mjs` is mounted: it keeps the web bundle (the fork
builds no desktop main bundle) and always prints one line, `web-startup: 893.7 kB of 900.0 kB`, or
`web-startup: 924.1 kB of 900.0 kB, over by 24.1 kB` followed by the largest files. Over the limit,
or a missing image or dist, fails (exit 2); about a second. Standalone, it measures whatever
`dozo-web` holds: build first. CI (`dozo-gate`) builds the Dockerfile's `build` stage alone from the
staged tree (`docker build --target build`) and runs the step on that image.

### qa

`make qa` runs `olc`, `stage`, `brand`, `checks`, `unit`, `build`, `budget`, `up`, `smoke`, then `down`. The terminal
gets `[qa] >> <step> (timeout <s>s, log <path>)` and `[qa] << <step> ok|FAIL|TIMEOUT <s>s` per step,
the last 40 log lines of a failed step, and the verdict. The first failing step stops the run. Each
step's full output is in `dozo/.stage/logs/<step>.log` (git-ignored). `e2e` is not part of it.

- Timeout per step: `DOZO_TIMEOUT_<STEP>` seconds (`<STEP>` upper case: `OLC`, `STAGE`, `BRAND`,
  `CHECKS`, `UNIT`, `BUILD`, `BUDGET`, `UP`, `SMOKE`, `DOWN`). Defaults: build 2400, unit 900, the rest 600. A step over
  its limit is killed and fails (exit 124, or 137 once past the limit when the step ignored TERM and was
  killed; both shown as TIMEOUT). `up` itself waits
  `DOZO_UP_TIMEOUT` (default 240).
- If project `dozo` was already running, qa updates it but does not take it down. Otherwise `down`
  runs after the steps, also after a failure, and on an interrupt.
- `DOZO_STOP_TIMEOUT` is the container stop timeout for `up` and `down`; qa sets 60 unless set,
  because upstream gives the worker a 50 minute grace period. Called directly, `build.sh` keeps the
  Compose value unless the variable is set.
- `DOZO_QA_STEPS="olc stage brand checks unit"` runs a subset in the order given.

## Upstream tests

`dozo/docker/upstream-tests.sh`, after `build.sh stage` and `build.sh brand`: upstream's own tests
on the branded stage, held to `dozo/brand/upstream-tests-known.tsv`, the reviewed list of upstream
tests that are red only on the branded tree on purpose. Not part of `olc` or `qa`: it takes about 20
minutes, so the workflow `dozo-upstream-tests` runs it on every pull request beside `dozo-gate`.

1. Every upstream test file (not `dozo-*`) on the branded stage, three workers.
2. The files with a red test, and the files the list names, on the unbranded tree of the same commit
   (`DOZO_STAGE_REF` or `HEAD`, in `<stage>/pristine`), so red that the brand step did not cause
   (no `git` or `python3` in the image, timing) is left out.
3. The files of any finding once more on the branded stage: a new red must be red again, and a
   listed test green again, so a flaky test fails neither way.
4. The verdict (`dozo/brand/upstream-tests.mjs`): a red test that is not listed, or a listed test
   that is no longer red only on the branded tree, fails (exit 2) and is named. Last line
   `UPSTREAM: PASS (<n> listed, <m> red only on the branded tree)` or `UPSTREAM: FAIL (...)`.

A list line is `file<TAB>test<TAB>class<TAB>reason`; the class is `a` (brand text or a renamed
identifier), `b` (a deliberate fork difference, naming its rule) or `c` (a fixture the fork's code
needs and the test lacks; prefer an anchored rule on the test that adds it). Adding a line is a
reviewed change with its reason; a fixed cause turns its tests green, which fails the job until the
line is removed, so the list only shrinks on its own. Each tree installs its own lockfile in a
scratch copy inside the container; reports and logs are in `<stage>/upstream-tests/`.

## Postgres tests

`dozo/docker/postgres-tests.sh`, after `build.sh stage` and `build.sh brand`: every
`dozo-*.postgres.test.ts` on the branded stage against a throwaway Postgres (`postgres:18-alpine`,
`DOZO_POSTGRES_IMAGE`) on a network of its own, once per time zone in `DOZO_PG_ZONES` (default
`UTC Europe/Istanbul America/Los_Angeles`). It migrates one database as upstream's integration
harness does (owner login for migrations, `rakazo_app` for the tests), copies it once per zone, sets
`TimeZone` on every role and the test process's `TZ` to the zone, and runs the files with three
workers, each file on its own copy of that database (`COPY_TEST_DATABASE`, as upstream's harness):
a test that changes a whole table never meets another file's rows. The local server's Postgres can take the zone of the person's machine, so fork SQL must
answer the same in every zone (`dozo/AGENTS.md`, Recurring mistakes). A skipped test fails the run:
every file runs only with a database, so a skip means it was never reached. The isolation
matrix's code proofs (`verifiedByCode` on an `unreached` exemption) are quoted from the branded
tree the tests run on, so a few match only there, after the brand rules. Not part of `olc` or
`qa`; the workflow `dozo-postgres-tests` runs it on every pull request (about 5 minutes). Last line
`POSTGRES: PASS (<n> files in <zones>)` or `POSTGRES: FAIL (...)`; exit 0, 2 failed, 64 usage. Logs
and one JSON report per zone are in `<stage>/postgres-tests/`.

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
| `DOZO_EMAIL_EMULATOR` | off | `1` on `up` starts the local stack with upstream's email emulator (`compose.email-emulator.yml`): mails are captured, not sent, and readable at `/api/dev/emails`, so sign-in by emailed code works end to end. The choice is written to the env file, so `down` matches; the next `up` without it turns it off. Local only |
| `DOZO_SMOKE_TIMEOUT` | `150` | Seconds `smoke` waits for the api, then for the worker, to be healthy |
| `DOZO_STOP_TIMEOUT` | unset; qa sets `60` | Seconds for `up` and `down` to stop containers |
| `DOZO_QA_STEPS` | all steps | Subset of qa steps |
| `DOZO_TIMEOUT_<STEP>` | build 2400, unit 900, else 600 | Per-step qa timeout in seconds |
| `DOZO_TIMEOUT_BIN` | `timeout`, else `gtimeout`, else none | Timeout command for qa steps; set to an empty string to force the built-in watchdog |
| `DOZO_UNIT_SRC` | `<stage>/src` | Tree `unit` tests. Makes a verdict partial when set |
| `DOZO_COVERAGE_MIN` | `90` | Web unit floor, per file, for the fork's `dozo-*` files |
| `DOZO_BRAND_COVERAGE_MIN` | `97` | Brand floor in `olc`, per file and overall (separate so the web floor is unaffected) |
| `DOZO_UPSTREAM_REF` | fresher of `upstream-main` and `origin/upstream-main` | Ref of the upstream-edit check, used as given; tests only |
| `CI` | unset | When set, `olc`, `checks` and `unit` pull a missing Node image instead of failing |

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
- Shared state, by step (a fixed name is shared only where concurrent use is safe): `olc`, `brand`,
  `checks` and the Postgres and upstream test runs work in the container's own filesystem and in
  per-checkout stage output, so they run side by side. `unit` shares the pnpm store and corepack and
  keeps a working copy per tree (above). `make olcum` has one working copy in `dozo-olcum-deps`, so
  it waits on `/tmp/dozo-olcum.lock`. `build`, `budget`, `up` and `smoke` use the one local stack
  (project `dozo`, its ports and the `dozo-*` images, `budget` reading the image `build` made): run
  them under `flock /tmp/dozo-yigin.lock`. `e2e` has its own per-user lock.
- Volumes: `dozo-qa-deps` (unit dependencies: shared store, one working copy per tree), `dozo-e2e-npm` (e2e),
  `dozo-upstream-tests-store` (the upstream tests' pnpm store), `dozo-postgres-tests-store` (the
  Postgres tests' pnpm store; that run's network and containers are `dozo-pgt-<pid>[-db|-node]` and
  go when it ends), and the project's `dozo_*`
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
  and api port 3100. It moves web to the generated port and stops publishing the api. It also
  makes the stack's network dual-stack: otherwise every computer start and stop briefly refuses
  connections on the web port (the file says why). Nothing else is overridden.

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
