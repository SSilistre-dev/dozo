#!/usr/bin/env bash
# Builds the linux-x64 server bundle on this machine, in Docker only (nothing on the host).
# Usage: dozo/server-bundle/build.sh <out-dir>
# Stages and brands the tree into <out-dir>/stage (dozo/docker/build.sh stage + brand, which never
# touch the local stack), then runs build.mjs in node:24.22-slim with --cpus 3 --memory 6g. The
# pnpm store is the volume DOZO_PNPM_STORE_VOLUME (default dozo-server-bundle-store), kept so a
# second build is faster; remove it with `docker volume rm` when done. Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ $# -eq 1 ] || { echo "usage: $0 <out-dir>" >&2; exit 64; }
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
STORE="${DOZO_PNPM_STORE_VOLUME:-dozo-server-bundle-store}"
NAME="dozo-server-bundle-build-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

export DOZO_STAGE_DIR="$OUT/stage"
"$ROOT/dozo/docker/build.sh" stage || exit 2
"$ROOT/dozo/docker/build.sh" brand || exit 2

# Root inside the container (corepack and apt need it); the output is handed back to the caller.
docker run --init --rm --name "$NAME" --cpus 3 --memory 6g \
  -v "$OUT/stage/src:/w" -v "$OUT:/out" -v "$HERE:/bundle:ro" -v "$STORE:/pnpm-store" \
  -e npm_config_store_dir=/pnpm-store -e HOST_IDS="$(id -u):$(id -g)" "$IMAGE" bash -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git xz-utils >/dev/null
    corepack enable; git config --global --add safe.directory "*"
    rc=0; node /bundle/build.mjs /w /out/dist || rc=$?
    chown -R "$HOST_IDS" /out
    exit $rc' || exit 2
