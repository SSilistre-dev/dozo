#!/usr/bin/env bash
# Gates: olc (fast, offline, <30s) and qa (full). Usage: gate.sh olc|qa
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
FAILS=()
fail() { FAILS+=("$1"); echo "[gate] FAIL: $1"; }

olc() {
  for s in dozo/docker/*.sh; do bash -n "$s" && echo "[olc] bash -n $s ok" || fail "syntax $s"; done
  mjs=(); while IFS= read -r f; do mjs+=("$f"); done < <(find dozo -name '*.mjs' -not -path 'dozo/.stage/*' 2>/dev/null)
  if [ "${#mjs[@]}" -eq 0 ]; then echo "[olc] no .mjs files, node --check skipped"
  elif docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
    docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" sh -c 'for f in "$@"; do node --check "$f" || exit 1; done' _ "${mjs[@]}" \
      && echo "[olc] node --check ${#mjs[@]} files ok" || fail "node --check"
    if [ -d dozo/brand ] && find dozo/brand -name '*.test.*' | grep -q .; then
      docker run --rm -v "$ROOT:/r:ro" -w /r "$NODE_IMAGE" node --test dozo/brand/ >/dev/null 2>&1 \
        && echo "[olc] brand unit tests ok" || fail "brand unit tests"
    else echo "[olc] no brand tests, skipped"; fi
  else echo "[olc] $NODE_IMAGE not present locally: node checks and brand tests SKIPPED"; fi
  local files mod
  files=$(find dozo -type f -not -path 'dozo/.stage/*' | wc -l | tr -d ' ')
  mod=$(git diff --name-only upstream-main -- . ':!dozo' ':!Makefile' | wc -l | tr -d ' ')
  echo "[olc] rules: dozo files=$files, upstream-tracked files modified vs upstream-main=$mod"
}

qa() {
  olc_run || return
  local b=dozo/docker/build.sh
  for st in stage brand build up smoke; do
    "$b" "$st" || { fail "$st (exit $?)"; break; }
  done
  "$b" down || fail "down"
}

olc_run() { olc; [ ${#FAILS[@]} -eq 0 ] || { echo "QA: FAIL (olc: ${FAILS[*]})"; exit 2; }; }

case "${1:-}" in
  olc) olc ;;
  qa) qa; V=QA ;;
  *) echo "usage: $0 olc|qa" >&2; exit 64 ;;
esac
V="${V:-OLC}"
if [ ${#FAILS[@]} -eq 0 ]; then echo "$V: PASS"; else echo "$V: FAIL (${FAILS[*]})"; exit 2; fi
