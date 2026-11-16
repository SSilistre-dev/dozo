#!/usr/bin/env bash
# Gates: olc (fast, offline, <30s) and qa (full). Usage: gate.sh olc|qa|unit
# `unit` is the qa step that runs the fork's own dozo-*.test.ts(x) on the branded staged tree.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
FAILS=()
# Fork-owned tests live inside upstream dirs as dozo-*.test.ts(x). Fewer than this after the
# local-model feature (fit, catalog, page) means tests went missing: a silent pass is a failure.
MIN_FORK_TESTS="${DOZO_MIN_FORK_TESTS:-3}"
fail() { FAILS+=("$1"); echo "[gate] FAIL: $1"; }

olc() {
  for s in dozo/docker/*.sh; do bash -n "$s" && echo "[olc] bash -n $s ok" || fail "syntax $s"; done
  mjs=(); while IFS= read -r f; do mjs+=("$f"); done < <(find dozo -name '*.mjs' -not -path 'dozo/.stage/*' -not -path 'dozo/.plumb-tmp/*' 2>/dev/null)
  if [ "${#mjs[@]}" -eq 0 ]; then echo "[olc] no .mjs files, node --check skipped"
  elif docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
    docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" sh -c 'for f in "$@"; do node --check "$f" || exit 1; done' _ "${mjs[@]}" \
      && echo "[olc] node --check ${#mjs[@]} files ok" || fail "node --check"
    if [ -d dozo/brand ] && find dozo/brand -name '*.test.*' | grep -q .; then
      docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test dozo/brand/ >/dev/null 2>&1 \
        && echo "[olc] brand unit tests ok" || fail "brand unit tests"
    else echo "[olc] no brand tests, skipped"; fi
  else echo "[olc] $NODE_IMAGE not present locally: node checks and brand tests SKIPPED"; fi
  local files mod forkfiles
  files=$(find dozo -type f -not -path 'dozo/.stage/*' -not -path 'dozo/.plumb-tmp/*' | wc -l | tr -d ' ')
  mod=$(git diff --name-only --diff-filter=M upstream-main -- . ':!dozo' ':!Makefile' | wc -l | tr -d ' ')
  forkfiles=$(git ls-files --cached --others --exclude-standard -- apps packages | grep -c '/dozo-[^/]*$' || true)
  echo "[olc] rules: dozo files=$files, upstream-tracked files modified vs upstream-main=$mod, dozo-* fork files inside upstream dirs=$forkfiles"
}

# Fork tests on the branded staged tree, in a container: the tree is copied inside it, dependencies
# are installed there, and nothing is written to the host (pnpm store lives in a volume we own).
unit_tests() {
  local src="${DOZO_UNIT_SRC:-$ROOT/dozo/.stage/src}" tests n
  [ -d "$src/apps" ] || { fail "unit: no staged tree, run dozo/docker/build.sh stage and brand first"; return 1; }
  tests=$(cd "$src" && find apps packages \( -name node_modules -prune \) -o -type f \( -name 'dozo-*.test.ts' -o -name 'dozo-*.test.tsx' \) -print | sort)
  n=$(printf '%s' "$tests" | grep -c . || true)
  echo "[unit] fork test files found: $n (minimum $MIN_FORK_TESTS)"
  if [ "$n" -lt "$MIN_FORK_TESTS" ]; then fail "unit: $n fork test files, expected at least $MIN_FORK_TESTS"; return 1; fi
  # shellcheck disable=SC2086
  docker run --rm -v "$src:/src:ro" -v dozo-qa-pnpm-store:/pnpm-store -e npm_config_store_dir=/pnpm-store -e CI=1 \
    "$NODE_IMAGE" sh -c 'set -e; mkdir /w; tar -C /src --exclude=./data -cf - . | tar -C /w -xf -; cd /w
      corepack enable; pnpm install --frozen-lockfile >/dev/null; pnpm exec vitest run "$@"' _ $tests \
    && echo "[unit] fork tests ok" || { fail "unit: fork tests (vitest)"; return 1; }
}

qa() {
  olc_run || return
  local b=dozo/docker/build.sh
  for st in stage brand unit build up smoke; do
    if [ "$st" = unit ]; then unit_tests || break
    else "$b" "$st" || { fail "$st (exit $?)"; break; }
    fi
  done
  "$b" down || fail "down"
}

olc_run() { olc; [ ${#FAILS[@]} -eq 0 ] || { echo "QA: FAIL (olc: ${FAILS[*]})"; exit 2; }; }

case "${1:-}" in
  olc) olc ;;
  qa) qa; V=QA ;;
  unit) unit_tests; V=UNIT ;;
  *) echo "usage: $0 olc|qa|unit" >&2; exit 64 ;;
esac
V="${V:-OLC}"
if [ ${#FAILS[@]} -eq 0 ]; then echo "$V: PASS"; else echo "$V: FAIL (${FAILS[*]})"; exit 2; fi
