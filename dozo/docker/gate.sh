#!/usr/bin/env bash
# Gates: olc (fast, offline once the Node image is local, <30s) and qa (full).
# Usage: gate.sh olc|qa|unit. Any failed gate exits 2.
# `unit` runs the fork's own dozo-*.test.ts(x) on the branded staged tree, with a coverage floor.
# `qa` runs olc, stage, brand, unit, build, up, smoke, down as logged, timed steps (see qa()).
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
PWD0="$PWD"
cd "$ROOT"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
# Docker reads a relative -v source as a named volume: make it absolute once (against the caller's
# directory) and pass it on to build.sh.
case "$STAGE" in /*) ;; *) STAGE="$PWD0/${STAGE#./}" ;; esac
export DOZO_STAGE_DIR="$STAGE"
LOGS="$STAGE/logs"
FAILS=()
PARTIAL=""
# Fork-owned tests live inside upstream dirs as dozo-*.test.ts(x). Fewer than this after the
# local-model feature (fit, catalog, page) means tests went missing: a silent pass is a failure.
MIN_FORK_TESTS="${DOZO_MIN_FORK_TESTS:-3}"
# Coverage floor (percent) for lines, branches and functions of the fork's own code.
COV_MIN="${DOZO_COVERAGE_MIN:-90}"
# The one upstream file the fork may edit, and only inside the marked block at its top.
README_FILE="README.md"
README_START="<!-- dozo:fork-notice:start -->"
README_END="<!-- dozo:fork-notice:end -->"
fail() { FAILS+=("$1"); echo "[gate] FAIL: $1"; }
now() { date +%s; }

# A skipped check must never end in PASS: CI pulls the image and fails if it cannot, a local run
# fails with the one command that fixes it (olc stays offline and fast once the image is cached).
node_image() {
  docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 && return 0
  if [ -n "${CI:-}" ]; then
    echo "[gate] CI: pulling $NODE_IMAGE"
    docker pull -q "$NODE_IMAGE" >/dev/null && return 0
    fail "cannot pull $NODE_IMAGE"; return 1
  fi
  fail "$NODE_IMAGE not present locally; run: docker pull $NODE_IMAGE"; return 1
}

# Print the coverage rows (and Vitest's own threshold errors) that are below the floor.
coverage_misses() { # stdin = tool output
  awk -F'|' -v min="$COV_MIN" '
    /does not meet|threshold/ { print; next }
    NF >= 4 { for (i = 2; i < NF; i++) if ($i ~ /[0-9]/ && $i + 0 < min) { print; break } }'
}

# True when the root README, with the marked fork-notice block and the one blank line after it
# removed, equals upstream's README at the merge base ($1). A missing end marker strips the rest of
# the file, so it differs; a README that upstream does not have is ours.
readme_outside_block() {
  git cat-file -e "$1:$README_FILE" 2>/dev/null || return 0
  awk -v s="$README_START" -v e="$README_END" '
    $0 == s { skip = 1; next }
    $0 == e { skip = 0; blank = 1; next }
    skip { next }
    blank && $0 == "" { blank = 0; next }
    { blank = 0; print }' "$README_FILE" 2>/dev/null | cmp -s - <(git show "$1:$README_FILE")
}

olc() {
  local s out
  # Every shell script under dozo/ (docker, sync, e2e/run.sh, brand assets), found, not listed, so a
  # new one is covered. The e2e .ts files have no cheap check (node --check cannot strip types, tsc
  # is not in the image): Playwright compiles them when `make e2e` runs.
  while IFS= read -r s; do bash -n "$s" && echo "[olc] bash -n $s ok" || fail "syntax $s"; done \
    < <(find dozo -name '*.sh' -not -path 'dozo/.stage/*' -not -path '*/node_modules/*' | sort)
  mjs=(); while IFS= read -r f; do mjs+=("$f"); done < <(find dozo -name '*.mjs' -not -path 'dozo/.stage/*' -not -path '*/node_modules/*' 2>/dev/null)
  if [ "${#mjs[@]}" -eq 0 ]; then fail "no .mjs files under dozo/: nothing to check with node"
  elif node_image; then
    docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" sh -c 'for f in "$@"; do node --check "$f" || exit 1; done' _ "${mjs[@]}" \
      && echo "[olc] node --check ${#mjs[@]} files ok" || fail "node --check"
    if [ -d dozo/brand ] && find dozo/brand -name '*.test.*' | grep -q .; then
      # Quiet on success; on failure the whole output is the reason. Node's thresholds are global,
      # so coverage_misses also names the files under the floor.
      out=$(docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test --experimental-test-coverage \
        --test-coverage-lines="$COV_MIN" --test-coverage-branches="$COV_MIN" --test-coverage-functions="$COV_MIN" dozo/brand/ 2>&1) \
        && echo "[olc] brand unit tests ok, coverage >= $COV_MIN%" \
        || { printf '%s\n' "$out"; printf '%s\n' "$out" | coverage_misses | sed 's/^/[olc] below floor: /'; fail "brand unit tests or coverage"; }
    else fail "no brand tests under dozo/brand (a check that cannot run is a failure)"; fi
    # Every anchored rule's file and anchor, and every `requires` file, against the repository's own
    # tree: a dry run (--check) that writes nothing, so a rule broken by an upstream change or a
    # renamed wrapper fails here and not only at `make qa`. --strict: the committed tree is
    # unbranded, so no rule can already be applied (that would be drift hidden by a short replace).
    if [ -f dozo/brand/apply.mjs ]; then
      out=$(docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node dozo/brand/apply.mjs --check --allow-git --strict --root /r 2>&1) \
        && echo "[olc] brand rules match the tree: $(printf '%s\n' "$out" | grep '^hooks:')" \
        || { printf '%s\n' "$out"; fail "brand rules do not match the tree (apply.mjs --check)"; }
    else fail "dozo/brand/apply.mjs missing: brand rules not checked"; fi
  fi
  local files forkfiles bad base
  files=$(find dozo -type f -not -path 'dozo/.stage/*' | wc -l | tr -d ' ')
  forkfiles=$(git ls-files --cached --others --exclude-standard -- apps packages | grep -c '/dozo-[^/]*$' || true)
  echo "[olc] rules: dozo files=$files, dozo-* fork files inside upstream dirs=$forkfiles"
  # dozo/AGENTS.md: the fork edits no upstream file but the marked block of the root README.md. A
  # file upstream has that differs here (edited, deleted, retyped) is a failure; added files are ours.
  # Compared with the merge base, not the tip of upstream-main: after an aborted sync or a daily
  # sync on origin the ref is ahead, and everything upstream changed since would look like our edit.
  if git rev-parse --verify -q 'upstream-main^{commit}' >/dev/null; then
    if base=$(git merge-base HEAD upstream-main 2>/dev/null) && [ -n "$base" ]; then
      bad=$(git diff --name-only --no-renames --diff-filter=MDT "$base" -- . ':!dozo' ':!Makefile' | grep -vxF "$README_FILE" || true)
      readme_outside_block "$base" || bad=$(printf '%s\n%s' "$bad" "$README_FILE (outside the fork-notice block)" | sed '/^$/d')
      if [ -z "$bad" ]; then echo "[olc] upstream files edited outside the allowed set ($README_FILE, notice block only): 0"
      else printf '%s\n' "$bad" | sed 's/^/[olc] upstream file differs from the merge base with upstream-main: /'; fail "upstream files edited: $(printf '%s\n' "$bad" | grep -c .)"; fi
    else fail "no merge base between HEAD and upstream-main: the upstream-edit check cannot run"; fi
  else
    echo "[olc] upstream-main ref missing: the upstream-edit check was NOT run (create it: git branch upstream-main upstream/main)"
  fi
  selftest
}

# Pure shell logic that needs no Docker: the coverage-miss parser, against a fixture of a Vitest
# table. Not covered: the stage swap and the worktree overlay (they need a scratch git repository),
# the unit volume sync, the compose steps and with_timeout (they need a Docker daemon).
selftest() {
  local got want
  # A here-string, not a heredoc inside $( ): bash 3.2 mis-parses a ")" there.
  got=$(COV_MIN=90 coverage_misses <<< $' File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s\n All files |   96.00 |    92.00 |     100 |     100 |\n ok.ts     |     100 |      100 |     100 |     100 | 12-30\n low.ts    |     100 |    80.50 |     100 |     100 |\nERROR: Coverage for lines (85%) does not meet global threshold (90%)')
  want=$' low.ts    |     100 |    80.50 |     100 |     100 |\nERROR: Coverage for lines (85%) does not meet global threshold (90%)'
  if [ "$got" = "$want" ]; then echo "[olc] selftest: coverage_misses ok"
  else fail "selftest coverage_misses"; printf '%s\n' "$got" | sed 's/^/[olc] got: /'; fi
}

# Fork tests on the branded staged tree, in a container; nothing is written to the host.
# Cost: a cold run installs everything (~40 s) and adds the coverage provider (~35 s). The volume
# dozo-qa-deps keeps the pnpm store, the corepack download and the installed node_modules, so an
# unchanged lockfile skips all of it. One fixed volume: the in-volume marker below notices a changed
# lockfile and reinstalls into it, so old lockfiles never pile up as one full node_modules each. It runs as root because it writes only
# to that volume; the staged tree is mounted read-only.
unit_tests() {
  local src="${DOZO_UNIT_SRC:-$STAGE/src}" tests n vol out
  [ -d "$src/apps" ] || { fail "unit: no staged tree, run dozo/docker/build.sh stage and brand first"; return 1; }
  tests=$(cd "$src" && find apps packages \( -name node_modules -prune \) -o -type f \( -name 'dozo-*.test.ts' -o -name 'dozo-*.test.tsx' \) -print | sort)
  n=$(printf '%s' "$tests" | grep -c . || true)
  echo "[unit] fork test files found: $n (minimum $MIN_FORK_TESTS)"
  if [ "$n" -lt "$MIN_FORK_TESTS" ]; then fail "unit: $n fork test files, expected at least $MIN_FORK_TESTS"; return 1; fi
  node_image || return 1
  vol=dozo-qa-deps
  out=$(mktemp "${TMPDIR:-/tmp}/dozo-unit-XXXXXX")
  # The coverage provider is not a project dependency: it is added inside the container only, at
  # the version of the staged tree's vitest, so the working tree's package.json is never touched.
  # shellcheck disable=SC2086
  docker run --rm -v "$src:/src:ro" -v "$vol:/cache" -e CI=1 -e COREPACK_HOME=/cache/corepack \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e DOZO_COVERAGE_MIN="$COV_MIN" "$NODE_IMAGE" sh -c 'set -e
      mkdir -p /cache/w /cache/store; cd /cache/w
      want=$(sha256sum /src/pnpm-lock.yaml | cut -d" " -f1)
      # Sync incrementally (no rsync in the image): a manifest of path, size and mtime in seconds per
      # file on both sides. Files only in the volume go; files new or different in the stage are
      # copied (tar keeps the mtime); the rest is left alone. Every node_modules and data/ are kept.
      export LC_ALL=C
      manifest() { (cd "$1" && find . -name node_modules -prune -o -path ./data -prune -o \( -type f -o -type l \) -printf "%p\t%s\t%Ts\0" | sort -z); }
      manifest /src > /tmp/src.m; manifest /cache/w > /tmp/vol.m
      cut -z -f1 /tmp/src.m > /tmp/src.p; cut -z -f1 /tmp/vol.m > /tmp/vol.p
      comm -z -13 /tmp/src.p /tmp/vol.p | xargs -0 -r rm -f
      comm -z -23 /tmp/src.m /tmp/vol.m | cut -z -f1 > /tmp/changed
      if [ -s /tmp/changed ]; then tar -C /src --null -T /tmp/changed -cf - | tar -C /cache/w -xf -; fi
      echo "[unit] sync: $(tr -cd "\0" < /tmp/changed | wc -c) file(s) copied, $(comm -z -13 /tmp/src.p /tmp/vol.p | tr -cd "\0" | wc -c) removed"
      corepack enable
      if [ "$(cat node_modules/.dozo-deps 2>/dev/null)" != "$want" ]; then
        echo "[unit] deps: cold cache or lockfile changed, installing"
        rm -f node_modules/.dozo-deps
        pnpm install --frozen-lockfile --store-dir /cache/store --loglevel=warn
        v=$(node -p "require(\"./node_modules/vitest/package.json\").version")
        pnpm add -Dw "@vitest/coverage-v8@$v" --store-dir /cache/store --loglevel=warn
        echo "$want" > node_modules/.dozo-deps
      else echo "[unit] deps: cached"; fi
      m=${DOZO_COVERAGE_MIN:-90}
      pnpm exec vitest run "$@" --coverage --coverage.reporter=text \
        --coverage.include="apps/**/dozo-*.ts" --coverage.include="apps/**/dozo-*.tsx" \
        --coverage.include="packages/**/dozo-*.ts" --coverage.include="packages/**/dozo-*.tsx" \
        --coverage.exclude="**/*.test.*" --coverage.thresholds.perFile \
        --coverage.thresholds.lines="$m" --coverage.thresholds.branches="$m" --coverage.thresholds.functions="$m"' \
    _ $tests 2>&1 | tee "$out"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then echo "[unit] fork tests ok, per-file coverage >= $COV_MIN%"; rm -f "$out"
  else coverage_misses < "$out" | sed 's/^/[unit] below floor: /'; rm -f "$out"; fail "unit: fork tests or coverage (vitest)"; return 1; fi
}

# --- qa: logged, timed steps ---
# The last full run lasted more than 45 minutes with no log: every step now writes its whole output
# to $LOGS/<step>.log, the terminal gets one start line and one end line per step (plus the last 40
# log lines on failure), and no step can run past its timeout.
TIMEOUT_BIN="${DOZO_TIMEOUT_BIN-$(command -v timeout || command -v gtimeout || true)}"

step_timeout() { # DOZO_TIMEOUT_<STEP> overrides, seconds
  local v d=600
  v="DOZO_TIMEOUT_$(printf '%s' "$1" | tr a-z A-Z)"
  case "$1" in build) d=2400 ;; unit) d=900 ;; esac
  echo "${!v:-$d}"
}

kill_tree() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill -TERM "$1" 2>/dev/null; return 0; }

# The running step and its watchdog, so a signal can clean both up. They are cleared as soon as the
# step is reaped: a later cleanup must never signal a pid the system has since reused.
WT_PID=""; WT_WD=""
wt_stop() { # idempotent; the watchdog goes first so it cannot fire at a step that is already gone
  [ -z "$WT_WD" ] || { kill_tree "$WT_WD"; wait "$WT_WD" 2>/dev/null; }
  [ -z "$WT_PID" ] || kill_tree "$WT_PID"
  WT_PID=""; WT_WD=""
}

# Exit 124 on timeout, like timeout(1). Without it (macOS has none) a background watchdog does it.
# The step always runs in the background and is waited for: a foreground wait would hold a trapped
# signal until the step ends. Without job control the step shares our process group, so "its group"
# is its process tree (kill_tree), never a group kill that would take this script with it.
with_timeout() { # seconds cmd...
  local limit="$1" pid flag rc; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 10 "$limit" "$@" & WT_PID=$!
    wait "$WT_PID"; rc=$?; WT_PID=""
    return "$rc"
  fi
  flag=$(mktemp "${TMPDIR:-/tmp}/dozo-timeout-XXXXXX"); rm -f "$flag"
  "$@" & pid=$!; WT_PID=$pid
  ( sleep "$limit"; : > "$flag"; kill_tree "$pid"; sleep 10; kill -KILL "$pid" 2>/dev/null ) & WT_WD=$!
  wait "$pid"; rc=$?; WT_PID=""   # reaped: wt_stop must not signal a pid the system may reuse
  wt_stop
  if [ -e "$flag" ]; then rm -f "$flag"; return 124; fi
  return "$rc"
}

# Set while qa owns a stack it started (never one that was already running).
QA_OWNS_STACK=0
on_signal() { # $1 = exit code (128 + signal number)
  trap ':' INT TERM   # a second signal must not cut the cleanup short; ':' is not inherited by children
  echo "[gate] interrupted"
  wt_stop
  if [ "$QA_OWNS_STACK" -eq 1 ]; then
    QA_OWNS_STACK=0
    echo "[qa] taking down the stack qa started"
    with_timeout 300 "$ROOT/dozo/docker/build.sh" down >>"$LOGS/down.log" 2>&1 || echo "[qa] down failed; run: dozo/docker/build.sh down"
  fi
  exit "$1"
}

run_step() { # name cmd...
  local name="$1" log limit s rc el; shift
  log="$LOGS/$name.log"; limit=$(step_timeout "$name"); s=$(now)
  echo "[qa] >> $name (timeout ${limit}s, log ${log#"$ROOT"/})"
  with_timeout "$limit" "$@" >"$log" 2>&1; rc=$?
  el=$(( $(now) - s ))
  if [ "$rc" -eq 0 ]; then echo "[qa] << $name ok ${el}s"; return 0; fi
  if [ "$rc" -eq 124 ]; then echo "[qa] << $name TIMEOUT after ${limit}s (raise DOZO_TIMEOUT_$(printf '%s' "$name" | tr a-z A-Z) if it is legitimate)"
  else echo "[qa] << $name FAIL exit $rc ${el}s"; fi
  echo "[qa] last 40 lines of $name:"; tail -n 40 "$log" | sed 's/^/[qa]   /'
  return "$rc"
}

# A stack already running under the project name is left running: a recreate-in-place by `up` is
# fine, but taking down what qa did not start is not. DOZO_STOP_TIMEOUT caps the stop wait of
# up/down: upstream gives the worker a 50 minute grace period, and a qa step that stops it blocks
# for that long unless the worker exits at once.
qa() {
  local t0 st was_up=0 reached_up=0 b="$ROOT/dozo/docker/build.sh"
  t0=$(now); mkdir -p "$LOGS"
  [ -z "$(docker ps -q --filter label=com.docker.compose.project=dozo --filter status=running 2>/dev/null)" ] || was_up=1
  export DOZO_STOP_TIMEOUT="${DOZO_STOP_TIMEOUT:-60}"
  [ "$was_up" -eq 0 ] || echo "[qa] project dozo is already running: qa will not take it down"
  # A subset of the steps, or an unbranded build, is not the full gate: the verdict line says so.
  local all="olc stage brand unit build up smoke" steps="${DOZO_QA_STEPS:-olc stage brand unit build up smoke}"
  [ "$(echo $steps)" = "$all" ] || PARTIAL="steps: $(echo $steps)"
  [ "${DOZO_SKIP_BRAND:-}" != 1 ] || PARTIAL="${PARTIAL:+$PARTIAL; }brand skipped (DOZO_SKIP_BRAND=1)"
  for st in $steps; do
    if [ "$st" = up ]; then reached_up=1; [ "$was_up" -eq 1 ] || QA_OWNS_STACK=1; fi
    case "$st" in
      olc|unit) run_step "$st" "$SELF" "$st" ;;
      *) run_step "$st" "$b" "$st" ;;
    esac || { fail "$st"; break; }
  done
  if [ "$reached_up" -eq 1 ] && [ "$was_up" -eq 0 ]; then run_step down "$b" down || fail down; QA_OWNS_STACK=0; fi
  QA_SECS=$(( $(now) - t0 ))
}

trap 'on_signal 130' INT; trap 'on_signal 143' TERM; trap wt_stop EXIT
case "${1:-}" in
  olc) T0=$(now); olc; V=OLC ;;
  qa) qa; V=QA ;;
  unit) T0=$(now); unit_tests; V=UNIT ;;
  *) echo "usage: $0 olc|qa|unit" >&2; exit 64 ;;
esac
SECS="${QA_SECS:-$(( $(now) - T0 ))}"
if [ ${#FAILS[@]} -eq 0 ]; then echo "$V: PASS${PARTIAL:+ (partial: $PARTIAL)} in ${SECS}s"
else echo "$V: FAIL ($(IFS=,; echo "${FAILS[*]}")) in ${SECS}s"; exit 2; fi
