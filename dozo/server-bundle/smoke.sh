#!/usr/bin/env bash
# End-to-end smoke test of a built linux-x64 server bundle, in Docker, in a plain Debian container
# with no Node and no Postgres installed: what a user's machine has before the desktop app sets up.
# Usage: dozo/server-bundle/smoke.sh <dist-dir> [log-dir]
#   <dist-dir> holds dozo-server-linux-x64.tar.xz and its .json from build.mjs. Writes
#   <dist-dir>/manifest.json (manifest.mjs, bundle url file:///dist/...) and the server logs to
#   [log-dir] (default <dist-dir>/smoke-logs).
# Steps: without libssl3 the start refuses with a clear message; then, with it: Node, Postgres and
# the bundle downloaded from the manifest and checked against its sha256, initdb, migrate, api,
# worker and web up, /health 200, sign-up without an email sender, a bot, an answer from a fake
# local model, and a clean stop (no process needed KILL).
# Last line: SERVER-BUNDLE SMOKE: PASS|FAIL. Exit 0 pass, 2 fail, 64 usage.
# Containers: --cpus 3 --memory 6g, named dozo-server-smoke-<pid>[-pre], removed at exit.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM=linux-x64
REPLY_TEXT="Hello from the local smoke model."

say() { echo "[smoke] $*"; }
verdict() { echo "SERVER-BUNDLE SMOKE: $1"; [ "$1" = PASS ] && exit 0 || exit 2; }
ms() { date +%s%3N; }

# --- inside the container, as root: test tools and libssl3, then the rest as an ordinary user ---
if [ "${1:-}" = --inside ]; then
  set -e
  t=$(ms)
  apt-get update -qq > /dev/null
  apt-get install -y -qq --no-install-recommends curl ca-certificates jq xz-utils libssl3 > /dev/null
  say "apt (curl, jq, xz, libssl3): $(( $(ms) - t )) ms"
  useradd -m dozo
  exec runuser -u dozo -- bash "$0" --as-user
fi

if [ "${1:-}" = --as-user ]; then
  set -e
  R=$HOME/runtime H=$HOME/state
  mkdir -p "$R/dl" "$R/node" "$R/postgres" "$R/server"
  t=$(ms)
  for part in server node postgres; do
    url=$(jq -er ".platforms[\"$PLATFORM\"].$part.url" /dist/manifest.json)
    sum=$(jq -er ".platforms[\"$PLATFORM\"].$part.sha256" /dist/manifest.json)
    file="$R/dl/$part.${url##*.}"
    curl -fsSL --retry 3 -o "$file" "$url"
    echo "$sum  $file" | sha256sum -c --quiet - || { say "FAILED: $part sha256 differs from the manifest"; exit 2; }
    say "$part: $(( $(stat -c %s "$file") / 1000000 )) MB, sha256 ok"
  done
  say "download and verify: $(( $(ms) - t )) ms"
  t=$(ms)
  tar -xJf "$R/dl/node.xz" -C "$R/node" --strip-components=1
  tar -xzf "$R/dl/postgres.gz" -C "$R/postgres" --strip-components=1
  tar -xJf "$R/dl/server.xz" -C "$R/server"
  rm -rf "$R/dl"
  say "unpack: $(( $(ms) - t )) ms, server $(du -sm "$R/server" | cut -f1) MB"
  export PATH="$R/node/bin:$PATH" DOZO_RUNTIME="$R" DOZO_HOME="$H" SMOKE_REPLY="$REPLY_TEXT"
  ! command -v psql > /dev/null || { say "FAILED: the container has a system Postgres"; exit 2; }
  node /bundle/fake-model.mjs 8001 > /tmp/fake-model.log 2>&1 &
  rc=0
  bash /bundle/run.sh start || rc=$?
  [ $rc != 0 ] || node /bundle/smoke-client.mjs http://127.0.0.1:5173 http://127.0.0.1:8001/v1 || rc=$?
  bash /bundle/run.sh stop || rc=2
  # No ps in a bare Debian: read the command lines from /proc.
  left=$(for p in /proc/[0-9]*; do tr '\0' ' ' < "$p/cmdline" 2> /dev/null; echo; done \
    | grep -E '^([^ ]*/)?node [^ ]*dist|^([^ ]*/)?postgres[ :]' || true)
  [ -z "$left" ] || { say "FAILED: still running after stop: $left"; rc=2; }
  [ $rc != 0 ] || say "error lines in the server logs: $(cat "$H"/logs/{api,worker,web}.log | grep -ciE '"level":"?(error|fatal)|"level":(50|60)' || true)"
  # Readable by the host's user (Postgres writes its log 0600).
  cp -r "$H/logs/." /logs/ 2>/dev/null && chmod -R a+rX /logs || true
  exit $rc
fi

# --- on the host ---
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: $0 <dist-dir> [log-dir]" >&2; exit 64; }
DIST="$(cd "$1" && pwd)" || exit 64
LOGS="${2:-$DIST/smoke-logs}"
mkdir -p "$LOGS" && LOGS="$(cd "$LOGS" && pwd)" && chmod 777 "$LOGS"   # written by the container's user
NAME="dozo-server-smoke-$$"
trap 'docker rm -f "$NAME" "$NAME-pre" > /dev/null 2>&1 || true' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM
[ -f "$DIST/dozo-server-$PLATFORM.tar.xz" ] || { say "FAILED: no dozo-server-$PLATFORM.tar.xz in $DIST"; verdict FAIL; }
LIMITS=(--cpus 3 --memory 6g)

# The manifest the container downloads from, built with the same script a release uses.
docker run --rm --name "$NAME-pre" "${LIMITS[@]}" --user "$(id -u):$(id -g)" -v "$HERE:/bundle:ro" -v "$DIST:/dist" \
  "${DOZO_NODE_IMAGE:-node:24.22-slim}" node /bundle/manifest.mjs /dist file:///dist || verdict FAIL

# Without libssl3 the start stops before touching anything, with a message that names it.
out=$(docker run --rm --name "$NAME-pre" "${LIMITS[@]}" -v "$HERE:/bundle:ro" debian:bookworm-slim \
  bash /bundle/run.sh preflight 2>&1); rc=$?
if [ $rc = 2 ] && grep -q 'libssl3' <<< "$out"; then say "no libssl3: refused with a clear message"
else say "FAILED: preflight without libssl3 exited $rc: $out"; verdict FAIL; fi

t=$(ms)
docker run --init --rm --name "$NAME" "${LIMITS[@]}" -v "$HERE:/bundle:ro" -v "$DIST:/dist:ro" -v "$LOGS:/logs" \
  debian:bookworm-slim bash /bundle/smoke.sh --inside; rc=$?
say "container total: $(( $(ms) - t )) ms, logs in $LOGS"
[ $rc = 0 ] && verdict PASS || verdict FAIL
