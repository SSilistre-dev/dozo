#!/usr/bin/env bash
# make olcum: measures code quality and readability and compares them with dozo/metrics/baseline.json.
# Usage: olcum.sh [--gate]. Exit 0 measured; 2 a step failed, or (with --gate) a fork score fell;
# 64 usage. What it measures and how it scores: dozo/metrics/README.md and the generated REPORT.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2
case "${1:-}" in "" | --gate) ;; *) echo "usage: $0 [--gate]" >&2; exit 64 ;; esac
[ $# -le 1 ] || { echo "usage: $0 [--gate]" >&2; exit 64; }
IMAGE=dozo-olcum:local
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
# Its own stage area, so the default stage, its lock and a running `make qa` are left alone.
STAGE="${DOZO_OLCUM_STAGE_DIR:-$ROOT/dozo/.stage/olcum}"
NAME="dozo-olcum-$$"
# The host runs other work too: every container is capped, and the measuring uses as many workers.
CPUS="${DOZO_OLCUM_CPUS:-3}"
LIMITS=(--cpus "$CPUS" --memory "${DOZO_OLCUM_MEMORY:-6g}")
fail() { echo "[olcum] FAIL: $1"; exit 2; }
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

T0=$(date +%s)
docker run --rm "${LIMITS[@]}" -v "$ROOT/dozo/metrics:/metrics:ro" "$NODE_IMAGE" node --test /metrics/score.test.mjs >/dev/null ||
  fail "the score formula's tests (node --test dozo/metrics/score.test.mjs)"
docker build -q -t "$IMAGE" dozo/metrics >/dev/null || fail "image build (dozo/metrics/Dockerfile)"
DOZO_STAGE_DIR="$STAGE" DOZO_STAGE_WORKTREE=1 dozo/docker/build.sh stage >/dev/null || fail "stage"
DOZO_STAGE_DIR="$STAGE" dozo/docker/build.sh brand >/dev/null || fail "brand"
rm -rf "$STAGE/out" && mkdir -p "$STAGE/out"
# The repository as git lists it (tracked and untracked-not-ignored), deleted files skipped, unpacked
# in the container; the measuring runs there, in the dozo-olcum-deps volume.
git ls-files -z -co --exclude-standard | tar --null --ignore-failed-read -T - -cf - 2>/dev/null |
  docker run -i --init --rm "${LIMITS[@]}" --name "$NAME" --label "dozo.run=olcum-$$" \
    -v "$STAGE/src:/stage:ro" -v dozo-olcum-deps:/cache -v "$STAGE/out:/out" \
    -e HOST_UID="$(id -u):$(id -g)" "$IMAGE" \
    bash -c 'rm -rf /cache/in && mkdir -p /cache/in && tar -C /cache/in -xf - && exec bash /cache/in/dozo/metrics/collect.sh' ||
  fail "measuring (output above)"
echo "[olcum] measured in $(($(date +%s) - T0))s"
# Scores, prints the change and writes baseline.json and REPORT.md as the invoking user; its last
# line is the verdict: OLCUM: kalite=NN okunabilirlik=NN (fork).
docker run --rm "${LIMITS[@]}" --user "$(id -u):$(id -g)" -v "$ROOT/dozo/metrics:/metrics" -v "$STAGE/out:/out:ro" \
  "$NODE_IMAGE" node /metrics/report.mjs /out/measures.json "$(git rev-parse --short HEAD)" "$@" ||
  exit 2
