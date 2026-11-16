#!/usr/bin/env bash
# Stage -> brand -> build -> up -> down for the Dozo fork. Never modifies the working tree.
# Usage: dozo/docker/build.sh [stage|brand|build|up|smoke|down|all] [--volumes]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# DOZO_STAGE_DIR (absolute, or relative to the current directory) moves the whole stage area, e.g. to
# a scratch dir for experiments.
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
# Docker reads a relative -v source as a named volume: make it absolute once, here.
case "$STAGE" in /*) ;; *) STAGE="$PWD/${STAGE#./}" ;; esac
SRC="$STAGE/src"
ENVF="$STAGE/dozo.env"
PROJECT=dozo
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
COMPOSE_REL=infra/compose/docker-compose.yml
STEP=init

say() { echo "[dozo] $*"; }
# A failed gate exits 2 (dozo/AGENTS.md); only a usage error is 64.
die() { local c="${2:-2}"; DIED=1; echo "[dozo] FAILED at step '$STEP': $1" >&2; exit "$c"; }
# Any other failure (a docker or git command under set -e) is also a gate failure: report it as 2.
trap 'rc=$?; [ $rc -ne 0 ] && [ "${DIED:-}" != 1 ] && echo "[dozo] FAILED at step '"'"'$STEP'"'"' (exit $rc)" >&2; [ $rc -eq 0 ] || [ $rc -eq 64 ] || rc=2; exit $rc' EXIT

# Run node in a container: repo dozo/ read-only at /dozo, staged tree at /w. It writes into the bind
# mount, so it runs as the invoking user: root-owned files would make a later rm -rf fail on Linux.
node_run() { docker run --rm --user "$(id -u):$(id -g)" -v "$ROOT/dozo:/dozo:ro" -v "$SRC:/w" -w /w "$NODE_IMAGE" node "$@"; }

dc() { # docker compose from inside the staged copy, upstream compose file untouched
  (cd "$SRC" && docker compose -p "$PROJECT" --env-file "$ENVF" \
    -f "$COMPOSE_REL" -f "$HERE/compose.ports.yml" "$@")
}

need_stage() { [ -f "$SRC/$COMPOSE_REL" ] || die "no staged tree at $SRC; run: dozo/docker/build.sh stage"; }

# Overlay uncommitted and untracked-but-not-ignored files onto $1. A tracked file deleted in the
# working tree is the one benign case (rsync would exit 23 on it), so it is dropped from the list
# up front and any rsync failure is real. git archive already put those files in the copy, so they
# are removed again: the gate must test the tree as it is, not files the working tree no longer has.
overlay_worktree() {
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard \
    | while IFS= read -r -d '' f; do if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi; done \
    | rsync -a --from0 --files-from=- ./ "$1/") || die "worktree overlay failed"
  (cd "$ROOT" && git ls-files -z --deleted | while IFS= read -r -d '' f; do rm -f "$1/$f"; done) \
    || die "removing deleted files from the staged copy failed"
}

stage() {
  STEP=stage
  local ref="${DOZO_STAGE_REF:-HEAD}" new="$STAGE/src.new"
  say "stage: exporting $ref${DOZO_STAGE_WORKTREE:+ + working tree} -> $SRC"
  mkdir -p "$STAGE"
  # Older versions parked the app data in data-keep and lost it when a stage failed midway.
  if [ -d "$STAGE/data-keep" ] && [ ! -e "$SRC/data" ]; then mkdir -p "$SRC"; mv "$STAGE/data-keep" "$SRC/data"; fi
  # Build the new tree on the side: a failure up to here leaves the old tree and its data untouched.
  rm -rf "$new"; mkdir -p "$new"
  (cd "$ROOT" && git archive "$ref") | tar -x -C "$new"
  [ "${DOZO_STAGE_WORKTREE:-}" != 1 ] || overlay_worktree "$new"
  rm -rf "$new/.git"
  [ -f "$new/$COMPOSE_REL" ] || die "staged tree lacks $COMPOSE_REL"
  # Swap in by contents, never moving data/ (the compose bind mount holding the app data).
  mkdir -p "$SRC"
  [ ! -e "$SRC/data" ] || rm -rf "$new/data"
  find "$SRC" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  find "$new" -mindepth 1 -maxdepth 1 -exec mv {} "$SRC/" \;
  rmdir "$new"
  say "stage: ok ($(find "$SRC" -type f | wc -l | tr -d ' ') files, no .git)"
}

brand() {
  STEP=brand; need_stage
  if [ "${DOZO_SKIP_BRAND:-}" = 1 ]; then say "brand: SKIPPED (DOZO_SKIP_BRAND=1), build will be UNBRANDED"; return 0; fi
  for f in apply check; do
    [ -f "$ROOT/dozo/brand/$f.mjs" ] || die "brand tool missing (dozo/brand/$f.mjs); set DOZO_SKIP_BRAND=1 to run unbranded for pipeline testing" 2
  done
  say "brand: apply.mjs"
  node_run /dozo/brand/apply.mjs --root /w || die "apply.mjs failed (rule failure or error)" 2
  say "brand: leak gate check.mjs"
  node_run /dozo/brand/check.mjs --root /w || die "leak gate found leaks" 2
  say "brand: ok, leak gate clean"
}

free_port() { local p="${1:-5173}"; while nc -z 127.0.0.1 "$p" 2>/dev/null; do p=$((p+1)); done; echo "$p"; }

setenv() { # setenv KEY VALUE (replace or append, no value echoed)
  if grep -q "^$1=" "$ENVF"; then
    local t; t="$(mktemp "${TMPDIR:-/tmp}/dozo-env-XXXXXX")"
    grep -v "^$1=" "$ENVF" > "$t"; echo "$1=$2" >> "$t"; cat "$t" > "$ENVF"; rm -f "$t"
  else echo "$1=$2" >> "$ENVF"; fi
}

genenv() {
  mkdir -p "$STAGE"
  if [ ! -f "$ENVF" ]; then
    say "env: generating dozo/.stage/dozo.env (random secrets, not printed)"
    ( umask 077
      {
        echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
        echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 16)"
        echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
        echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
        echo "SCREEN_PROXY_SECRET=$(openssl rand -hex 32)"
        echo "SANDBOX_SUPERVISOR_TOKEN=$(openssl rand -hex 32)"
        echo "RAKAZO_WEB_BIND=127.0.0.1"
      } > "$ENVF" )
  fi
  # Our stack binds to 127.0.0.1 on the user's own machine, so private model endpoints (a local
  # OpenAI-compatible server) are allowed. Reaches api and worker through upstream's x-app-environment.
  setenv MCP_ALLOW_PRIVATE_ENDPOINT true
  # Keep the port if our own web container is running; otherwise pick a free one.
  # The service list is captured first: `dc ps | grep -q` under pipefail can fail on SIGPIPE.
  local cur running; cur="$(grep '^DOZO_WEB_PORT=' "$ENVF" | cut -d= -f2 || true)"
  running="$(dc ps --status running --services 2>/dev/null || true)"
  if [ -z "$cur" ] || { [[ $'\n'"$running"$'\n' != *$'\nweb\n'* ]] && nc -z 127.0.0.1 "$cur" 2>/dev/null; }; then
    cur="$(free_port "${DOZO_WEB_PORT:-5173}")"
  fi
  setenv DOZO_WEB_PORT "$cur"
  setenv WEB_ORIGIN "http://127.0.0.1:$cur"
  setenv BETTER_AUTH_URL "http://127.0.0.1:$cur"
  setenv RAKAZO_EXTRA_AUTH_ORIGINS "http://localhost:$cur"
  PORT="$cur"
}

build() {
  STEP=build; need_stage; genenv
  say "build: computer sandbox image (from compose service 'computer', same as sandbox:build)"
  COMPOSE_PARALLEL_LIMIT=1 dc build computer
  say "build: app images, one at a time (Docker VM memory is limited)"
  COMPOSE_PARALLEL_LIMIT=1 dc build
  say "build: ok"
  dc config --images | sort -u | sed 's/^/[dozo] image: /'
}

up() {
  STEP=up; need_stage; genenv
  say "up: starting project '$PROJECT'"
  # DOZO_STOP_TIMEOUT (seconds) caps how long recreating a running service may wait; upstream's
  # worker grace is 50 min. Unset keeps the compose value. gate.sh qa sets it.
  dc up -d ${DOZO_STOP_TIMEOUT:+--timeout "$DOZO_STOP_TIMEOUT"}
  say "up: waiting for web on 127.0.0.1:$PORT"
  # A wall-clock limit (DOZO_UP_TIMEOUT seconds), so the message is true however long each probe takes.
  local limit="${DOZO_UP_TIMEOUT:-240}" end; end=$(( $(date +%s) + limit ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = 200 ] && { say "up: web answers at http://127.0.0.1:$PORT/"; return 0; }
    sleep 2
  done
  dc ps || true; die "web did not answer 200 within ${limit}s (DOZO_UP_TIMEOUT)"
}

smoke() {
  STEP=smoke; genenv
  local url="http://127.0.0.1:$PORT/" code title
  code="$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$url" || true)"
  title="$(curl -s --max-time 10 "$url" | tr '\n' ' ' | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p')"
  say "smoke: http=$code title='$title' url=$url"
  [ "$code" = 200 ] || die "web returned $code" 2
  [ -n "$title" ] || die "no <title> in HTML" 2
  if [ "${DOZO_SKIP_BRAND:-}" != 1 ]; then
    echo "$title" | grep -qi dozo || die "title not branded: '$title'" 2
    ! echo "$title" | grep -qi rakazo || die "title still says Rakazo: '$title'" 2
  fi
  say "smoke: ok"
}

down() {
  STEP=down; need_stage
  say "down: project '$PROJECT'${VOLUMES:+ (with volumes)}"
  dc down ${DOZO_STOP_TIMEOUT:+--timeout "$DOZO_STOP_TIMEOUT"} ${VOLUMES:+--volumes}
}

CMD="${1:-all}"; VOLUMES=""; [ "${2:-}" = "--volumes" ] && VOLUMES=1
case "$CMD" in
  stage) stage ;; brand) brand ;; build) build ;; up) up ;; smoke) smoke ;; down) down ;;
  all) stage; brand; build; up ;;
  *) echo "usage: $0 [stage|brand|build|up|smoke|down|all] [--volumes]" >&2; exit 64 ;;
esac
