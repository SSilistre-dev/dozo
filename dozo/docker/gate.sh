#!/usr/bin/env bash
# Gates: olc (fast, offline once the Node image is local, <30s) and qa (full).
# Usage: gate.sh olc|qa|unit. Any failed gate exits 2.
# `unit` runs the fork's own dozo-*.test.ts(x) on the branded staged tree, with a coverage floor.
# `qa` runs olc, stage, brand, unit, build, up, smoke, down as logged, timed steps (see qa()).
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/../.." && pwd)"
cd "$ROOT"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
LOGS="$STAGE/logs"
FAILS=()
# Fork-owned tests live inside upstream dirs as dozo-*.test.ts(x). Fewer than this after the
# local-model feature (fit, catalog, page) means tests went missing: a silent pass is a failure.
MIN_FORK_TESTS="${DOZO_MIN_FORK_TESTS:-3}"
# Coverage floor (percent) for lines, branches and functions of the fork's own code.
COV_MIN="${DOZO_COVERAGE_MIN:-90}"
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

olc() {
  local s
  # Every shell script under dozo/ (docker, sync, e2e/run.sh, brand assets), found, not listed, so a
  # new one is covered. The e2e .ts files have no cheap check (node --check cannot strip types, tsc
  # is not in the image): Playwright compiles them when `make e2e` runs.
  while IFS= read -r s; do bash -n "$s" && echo "[olc] bash -n $s ok" || fail "syntax $s"; done \
    < <(find dozo -name '*.sh' -not -path 'dozo/.stage/*' -not -path '*/node_modules/*' | sort)
  mjs=(); while IFS= read -r f; do mjs+=("$f"); done < <(find dozo -name '*.mjs' -not -path 'dozo/.stage/*' 2>/dev/null)
  if [ "${#mjs[@]}" -eq 0 ]; then echo "[olc] no .mjs files, nothing to check with node"
  elif node_image; then
    docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" sh -c 'for f in "$@"; do node --check "$f" || exit 1; done' _ "${mjs[@]}" \
      && echo "[olc] node --check ${#mjs[@]} files ok" || fail "node --check"
    if [ -d dozo/brand ] && find dozo/brand -name '*.test.*' | grep -q .; then
      # Quiet on success; on failure the whole output is the reason. Node's thresholds are global,
      # so coverage_misses also names the files under the floor.
      local out
      out=$(docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test --experimental-test-coverage \
        --test-coverage-lines="$COV_MIN" --test-coverage-branches="$COV_MIN" --test-coverage-functions="$COV_MIN" dozo/brand/ 2>&1) \
        && echo "[olc] brand unit tests ok, coverage >= $COV_MIN%" \
        || { printf '%s\n' "$out"; printf '%s\n' "$out" | coverage_misses | sed 's/^/[olc] below floor: /'; fail "brand unit tests or coverage"; }
    else echo "[olc] no brand tests, skipped"; fi
  fi
  local files mod forkfiles
  files=$(find dozo -type f -not -path 'dozo/.stage/*' | wc -l | tr -d ' ')
  mod=$(git diff --name-only --diff-filter=M upstream-main -- . ':!dozo' ':!Makefile' | wc -l | tr -d ' ')
  forkfiles=$(git ls-files --cached --others --exclude-standard -- apps packages | grep -c '/dozo-[^/]*$' || true)
  echo "[olc] rules: dozo files=$files, upstream-tracked files modified vs upstream-main=$mod, dozo-* fork files inside upstream dirs=$forkfiles"
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
      # New sources in, files that no longer exist out, every node_modules kept.
      find /cache/w -name node_modules -prune -o \( -type f -o -type l \) -exec rm -f {} +
      tar -C /src --exclude=./data -cf - . | tar -C /cache/w -xf -
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
  wait "$pid"; rc=$?
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
  for st in ${DOZO_QA_STEPS:-olc stage brand unit build up smoke}; do
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
if [ ${#FAILS[@]} -eq 0 ]; then echo "$V: PASS in ${SECS}s"
else echo "$V: FAIL ($(IFS=,; echo "${FAILS[*]}")) in ${SECS}s"; exit 2; fi
