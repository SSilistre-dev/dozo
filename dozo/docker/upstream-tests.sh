#!/usr/bin/env bash
# Upstream's tests on the branded tree, held to the reviewed list of the ones the brand step may
# turn red (dozo/brand/upstream-tests-known.tsv). Run it on a branded stage:
#   dozo/docker/build.sh stage && dozo/docker/build.sh brand && dozo/docker/upstream-tests.sh
# 1. every upstream test file (not dozo-*) on the branded stage;
# 2. the files with a red test, and the files the list names, on the unbranded tree of the same
#    commit (DOZO_STAGE_REF or HEAD), so red that the brand step did not cause is left out;
# 3. once more on the branded stage, the files of any finding, so a flaky test fails neither way;
# 4. the verdict (dozo/brand/upstream-tests.mjs): a new red, or a listed test no longer red only on
#    the branded tree, fails. Last line UPSTREAM: PASS|FAIL. Exit 0, 2 failed, 64 usage.
# Reports and logs: <stage>/upstream-tests/. The pnpm store is kept in the volume
# dozo-upstream-tests-store (remove it to start cold). See dozo/docker/README.md, Upstream tests.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
case "$STAGE" in /*) ;; *) STAGE="$PWD/${STAGE#./}" ;; esac
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
KNOWN=/dozo/brand/upstream-tests-known.tsv
OUT="$STAGE/upstream-tests"
PRISTINE="$STAGE/pristine"
STORE=dozo-upstream-tests-store
RUN_ID="ut-$$"

die() { echo "[upstream] $1" >&2; echo "UPSTREAM: FAIL ($1)"; exit 2; }
cleanup() {
  local rc=$? ids
  ids=$(docker ps -aq --filter "label=dozo.run=$RUN_ID" 2>/dev/null || true)
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  [ $rc -eq 0 ] || [ $rc -eq 64 ] || rc=2
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

[ $# -eq 0 ] || { echo "usage: $0 (no arguments; DOZO_STAGE_DIR, DOZO_STAGE_REF, DOZO_NODE_IMAGE)" >&2; exit 64; }
command -v docker >/dev/null || die "docker not found"
[ -f "$STAGE/stage.complete" ] && [ -f "$STAGE/src/package.json" ] \
  || die "no branded stage: run dozo/docker/build.sh stage and dozo/docker/build.sh brand first"

rm -rf "$OUT" "$PRISTINE"; mkdir -p "$OUT" "$PRISTINE"
# The unbranded tree as `build.sh stage` makes it: no root Makefile, nothing of dozo/ but its licence.
git -C "$ROOT" archive "${DOZO_STAGE_REF:-HEAD}" | tar -x -C "$PRISTINE"
rm -f "$PRISTINE/Makefile"
find "$PRISTINE/dozo" -mindepth 1 -maxdepth 1 ! -name NOTICE ! -name LICENSE -exec rm -rf {} +

# run <name> <tree> [test files...]: installs the tree's own lockfile in a scratch copy inside the
# container (the tree is mounted read-only) and writes <name>.json; no files means every one.
run() {
  local name="$1" tree="$2" t0=$SECONDS; shift 2
  echo "[upstream] >> $name ($# files$([ $# -gt 0 ] || echo ': all'))"
  docker run --init --rm --name "dozo-$RUN_ID-$name" --label "dozo.run=$RUN_ID" --cpus 3 --memory 6g \
    -v "$tree:/src:ro" -v "$STORE:/store" -v "$OUT:/out" -e CI=1 -e TZ=UTC \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e COREPACK_HOME=/store/corepack -e OWNER="$(id -u):$(id -g)" \
    "$NODE_IMAGE" sh -c '
      set -e; name=$1; shift
      trap "chown -R \"\$OWNER\" /out" EXIT
      mkdir /w && (cd /src && tar -cf - --exclude=./node_modules .) | tar -C /w -xf - && cd /w
      corepack enable
      pnpm install --frozen-lockfile --store-dir /store/pnpm --loglevel=warn >"/out/$name-install.log" 2>&1 \
        || { tail -20 "/out/$name-install.log"; exit 3; }
      pnpm --filter @rakazo/db generate >"/out/$name-generate.log" 2>&1 || { tail -20 "/out/$name-generate.log"; exit 3; }
      # Red tests are the point: the run exits non-zero then, and only a missing report fails here.
      node node_modules/vitest/vitest.mjs run --maxWorkers=3 --exclude "**/dozo-*" \
        --reporter=json --outputFile.json="/out/$name.json" "$@" >"/out/$name.log" 2>&1 || true
      test -s "/out/$name.json" || { tail -40 "/out/$name.log"; exit 3; }' _ "$name" "$@" \
    || die "the $name run did not produce a report (logs in $OUT)"
  echo "[upstream] << $name $((SECONDS - t0))s"
}
# judge <command> [options]: the comparison, in the Node image, reading the real dozo/.
judge() {
  docker run --init --rm --name "dozo-$RUN_ID-judge" --label "dozo.run=$RUN_ID" --user "$(id -u):$(id -g)" \
    -v "$ROOT/dozo:/dozo:ro" -v "$OUT:/out:ro" "$NODE_IMAGE" \
    node /dozo/brand/upstream-tests.mjs "$1" --known "$KNOWN" --branded /out/branded.json "${@:2}"
}
lines() { local f; files=(); while IFS= read -r f; do [ -z "$f" ] || files+=("$f"); done; }

run branded "$STAGE/src"
judge files > "$OUT/files.txt" || { cat "$OUT/files.txt"; die "the list or the branded report is malformed"; }
lines < "$OUT/files.txt"
if [ "${#files[@]}" -gt 0 ]; then run pristine "$PRISTINE" "${files[@]}"
else echo '{"testResults":[]}' > "$OUT/pristine.json"; fi
judge suspects --pristine /out/pristine.json > "$OUT/suspects.txt" || die "the unbranded report is malformed"
lines < "$OUT/suspects.txt"
recheck=()
if [ "${#files[@]}" -gt 0 ]; then run recheck "$STAGE/src" "${files[@]}"; recheck=(--recheck /out/recheck.json); fi
judge verdict --pristine /out/pristine.json "${recheck[@]}"
