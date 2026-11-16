#!/usr/bin/env bash
# Stage -> brand -> build -> up -> down for the Dozo fork. Never modifies the working tree.
# Usage: dozo/docker/build.sh [stage|brand|build|up|smoke|down|all] [--volumes]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="$ROOT/dozo/.stage"
SRC="$STAGE/src"
ENVF="$STAGE/dozo.env"
PROJECT=dozo
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24-slim}"
COMPOSE_REL=infra/compose/docker-compose.yml
STEP=init

say() { echo "[dozo] $*"; }
die() { local c="${2:-1}"; DIED=1; echo "[dozo] FAILED at step '$STEP': $1" >&2; exit "$c"; }
trap 'rc=$?; [ $rc -ne 0 ] && [ "${DIED:-}" != 1 ] && echo "[dozo] FAILED at step '"'"'$STEP'"'"' (exit $rc)" >&2; exit $rc' EXIT

# Run node in a container: repo dozo/ read-only at /dozo, staged tree at /w.
node_run() { docker run --rm -v "$ROOT/dozo:/dozo:ro" -v "$SRC:/w" -w /w "$NODE_IMAGE" node "$@"; }

dc() { # docker compose from inside the staged copy, upstream compose file untouched
  (cd "$SRC" && docker compose -p "$PROJECT" --env-file "$ENVF" \
    -f "$COMPOSE_REL" -f "$HERE/compose.ports.yml" "$@")
}

need_stage() { [ -f "$SRC/$COMPOSE_REL" ] || die "no staged tree at dozo/.stage/src; run: dozo/docker/build.sh stage"; }

stage() {
  STEP=stage
  local ref="${DOZO_STAGE_REF:-HEAD}" keep=""
  say "stage: exporting $ref${DOZO_STAGE_WORKTREE:+ + working tree} -> dozo/.stage/src"
  if [ -d "$SRC/data" ]; then keep="$STAGE/data-keep"; rm -rf "$keep"; mv "$SRC/data" "$keep"; fi
  rm -rf "$SRC"; mkdir -p "$SRC"
  (cd "$ROOT" && git archive "$ref") | tar -x -C "$SRC"
  if [ "${DOZO_STAGE_WORKTREE:-}" = 1 ]; then
    # Overlay tracked-modified and untracked-but-not-ignored files (deleted files are skipped).
    (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard \
      | rsync -a --from0 --files-from=- ./ "$SRC/") 2>/dev/null || [ $? -eq 23 ] || die "worktree overlay failed"
  fi
  [ -z "$keep" ] || mv "$keep" "$SRC/data"   # keep bind-mounted app data across restages
  rm -rf "$SRC/.git"
  [ -f "$SRC/$COMPOSE_REL" ] || die "staged tree lacks $COMPOSE_REL"
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
    local t; t="$(mktemp "${TMPDIR:-/tmp}/dozo-wp2-XXXXXX")"
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
  # Keep the port if our own web container is running; otherwise pick a free one.
  local cur; cur="$(grep '^DOZO_WEB_PORT=' "$ENVF" | cut -d= -f2 || true)"
  if [ -z "$cur" ] || { ! dc ps --status running --services 2>/dev/null | grep -qx web && nc -z 127.0.0.1 "$cur" 2>/dev/null; }; then
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
  dc up -d
  say "up: waiting for web on 127.0.0.1:$PORT"
  local i; for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = 200 ] && { say "up: web answers at http://127.0.0.1:$PORT/"; return 0; }
    sleep 2
  done
  dc ps || true; die "web did not answer 200 within 240s"
}

smoke() {
  STEP=smoke; genenv
  local url="http://127.0.0.1:$PORT/" code title
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  title="$(curl -s "$url" | tr '\n' ' ' | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p')"
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
  dc down ${VOLUMES:+--volumes}
}

CMD="${1:-all}"; VOLUMES=""; [ "${2:-}" = "--volumes" ] && VOLUMES=1
case "$CMD" in
  stage) stage ;; brand) brand ;; build) build ;; up) up ;; smoke) smoke ;; down) down ;;
  all) stage; brand; build; up ;;
  *) echo "usage: $0 [stage|brand|build|up|smoke|down|all] [--volumes]" >&2; exit 64 ;;
esac
