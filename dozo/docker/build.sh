#!/usr/bin/env bash
# Stage -> brand -> build -> up -> down for the Dozo fork. Never modifies the working tree.
# Usage: dozo/docker/build.sh [stage|brand|build|up|smoke|down|all] [--volumes]   (--volumes: down only)
# No argument = all (stage, brand, build, up). Exit 0 ok, 2 failed (also a missing host tool and an
# interrupt), 64 usage. Commands, variables and Docker objects: dozo/docker/README.md.
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
STAGED="$STAGE/stage.complete"   # written last by `stage`, removed first: a swap cut short has none
STEP=init

say() { echo "[dozo] $*"; }
# A failed gate exits 2 (dozo/AGENTS.md); only a usage error is 64.
die() { local c="${2:-2}"; DIED=1; echo "[dozo] FAILED at step '$STEP': $1" >&2; exit "$c"; }
# Any other failure (a docker or git command under set -e) is also a gate failure: report it as 2.
# One handler for exit, INT and TERM: it also removes the temp files and the containers of this run.
cleanup() {
  local rc=$? ids
  trap '' INT TERM; trap - EXIT   # a second signal must not cut the cleanup short
  [ $rc -eq 0 ] || [ $rc -eq 64 ] || [ "${DIED:-}" = 1 ] || echo "[dozo] FAILED at step '$STEP' (exit $rc)" >&2
  [ -z "${ENV_TMP:-}" ] || rm -f "$ENV_TMP"
  rm -f "$ENVF.new"
  ids=$(docker ps -aq --filter "label=dozo.run=build-$$" 2>/dev/null) || ids=""
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
  [ $rc -eq 0 ] || [ $rc -eq 64 ] || rc=2
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

# Host tools the steps use. A missing one is a clear exit 2, not a silent wrong answer (without nc
# the free-port probe would call a busy port free).
need() { local t; for t in "$@"; do command -v "$t" >/dev/null 2>&1 || die "'$t' not found on PATH; it is needed on the host for this step (nothing is installed for you)" 2; done; }
# compose.ports.yml uses `!override` and `!reset`, which need Compose 2.24.4 or newer.
need_compose() {
  local v; need docker
  v="$(docker compose version --short 2>/dev/null | sed 's/^v//')" || v=""
  case "$v" in [0-9]*.[0-9]*.[0-9]*) ;; *) die "docker compose (v2 plugin) not found or unreadable version '$v'; Compose 2.24.4+ is required" 2 ;; esac
  printf '%s' "$v" | awk -F'[.-]' '{ split("2.24.4", m, "."); for (i = 1; i <= 3; i++) { if ($i + 0 > m[i] + 0) exit 0; if ($i + 0 < m[i] + 0) exit 1 } exit 0 }' \
    || die "docker compose $v is too old: compose.ports.yml needs 2.24.4 or newer (!override, !reset)" 2
}

# Run node in a container: repo dozo/ read-only at /dozo, staged tree at /w. It writes into the bind
# mount, so it runs as the invoking user: root-owned files would make a later rm -rf fail on Linux.
# --init, a name unique to this run and a label: the EXIT/INT/TERM handler removes it if we are killed.
node_run() { docker run --init --rm --name "dozo-node-$$" --label "dozo.run=build-$$" --user "$(id -u):$(id -g)" -v "$ROOT/dozo:/dozo:ro" -v "$SRC:/w" -w /w "$NODE_IMAGE" node "$@"; }

# docker compose from inside the staged copy, upstream compose file untouched. The env file is the
# one source of truth: compose lets an exported variable beat --env-file, so every key the file holds
# is removed from the environment first (names only, values are never read out). DOZO_WEB_PORT in
# the caller's shell only seeds the generation of the file (genenv).
dc() {
  local k clean=()
  if [ -f "$ENVF" ]; then while IFS='=' read -r k _; do [ -z "$k" ] || clean+=(-u "$k"); done < "$ENVF"; fi
  (cd "$SRC" && env ${clean[@]+"${clean[@]}"} docker compose -p "$PROJECT" --env-file "$ENVF" \
    -f "$COMPOSE_REL" -f "$HERE/compose.ports.yml" "$@")
}

# A swap cut short leaves a partial tree that still has the compose file: only the marker says it is whole.
need_stage() { [ -f "$STAGED" ] && [ -f "$SRC/$COMPOSE_REL" ] || die "no complete staged tree at $SRC; run: dozo/docker/build.sh stage"; }

# Overlay uncommitted and untracked-but-not-ignored files onto $1 (the copy of ref $2). A tracked
# file deleted in the working tree is the one benign case (rsync would exit 23 on it), so it is
# dropped from the list up front and any rsync failure is real. git archive already put those files
# in the copy, so they are removed again: the gate must test the tree as it is, not files the
# working tree no longer has. The deleted paths come from a diff of the ref against the working
# tree: unlike `git ls-files --deleted` (index entries missing on disk) it also names a staged
# deletion or rename, and --no-renames turns a rename into delete + add, so the old path goes and
# the new one (in the index, hence copied above) stays. A path that exists on disk is never removed.
overlay_worktree() {
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard \
    | while IFS= read -r -d '' f; do if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi; done \
    | rsync -a --from0 --files-from=- ./ "$1/") || die "worktree overlay failed"
  (cd "$ROOT" && git diff --name-only --no-renames --diff-filter=D -z "$2" -- \
    | while IFS= read -r -d '' f; do if [ ! -e "$f" ] && [ ! -L "$f" ]; then rm -f "$1/$f"; fi; done) \
    || die "removing deleted files from the staged copy failed"
}

stage() {
  STEP=stage
  local ref="${DOZO_STAGE_REF:-HEAD}" new="$STAGE/src.new"
  need git tar; [ "${DOZO_STAGE_WORKTREE:-}" != 1 ] || need rsync
  say "stage: exporting $ref$([ "${DOZO_STAGE_WORKTREE:-}" != 1 ] || echo ' + working tree') -> $SRC"
  mkdir -p "$STAGE"
  # Older versions parked the app data in data-keep and lost it when a stage failed midway.
  if [ -d "$STAGE/data-keep" ] && [ ! -e "$SRC/data" ]; then mkdir -p "$SRC"; mv "$STAGE/data-keep" "$SRC/data"; fi
  # Build the new tree on the side: a failure up to here leaves the old tree and its data untouched.
  rm -rf "$new"; mkdir -p "$new"
  (cd "$ROOT" && git archive "$ref") | tar -x -C "$new"
  [ "${DOZO_STAGE_WORKTREE:-}" != 1 ] || overlay_worktree "$new" "$ref"
  rm -rf "$new/.git"
  [ -f "$new/$COMPOSE_REL" ] || die "staged tree lacks $COMPOSE_REL"
  # Swap in by contents, never moving data/ (the compose bind mount holding the app data). The
  # marker goes first and comes back last, so an interrupted swap is never taken for a whole tree.
  rm -f "$STAGED"
  mkdir -p "$SRC"
  [ ! -e "$SRC/data" ] || rm -rf "$new/data"
  find "$SRC" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  find "$new" -mindepth 1 -maxdepth 1 -exec mv {} "$SRC/" \;
  rmdir "$new"
  : > "$STAGED"
  say "stage: ok ($(find "$SRC" -type f | wc -l | tr -d ' ') files, no .git)"
}

brand() {
  STEP=brand; need_stage; need docker
  if [ "${DOZO_SKIP_BRAND:-}" = 1 ]; then say "brand: SKIPPED (DOZO_SKIP_BRAND=1), build will be UNBRANDED"; return 0; fi
  for f in apply check; do
    [ -f "$ROOT/dozo/brand/$f.mjs" ] || die "brand tool missing (dozo/brand/$f.mjs); set DOZO_SKIP_BRAND=1 to run unbranded for pipeline testing" 2
  done
  say "brand: apply.mjs"
  node_run /dozo/brand/apply.mjs --root /w --strict || die "apply.mjs failed (rule failure or error)" 2
  say "brand: leak gate check.mjs"
  node_run /dozo/brand/check.mjs --root /w || die "leak gate found leaks" 2
  say "brand: ok, leak gate clean"
}

free_port() { local p="${1:-5173}"; while nc -z 127.0.0.1 "$p" 2>/dev/null; do p=$((p+1)); done; echo "$p"; }

setenv() { # setenv KEY VALUE (replace or append, no value echoed)
  if grep -q "^$1=" "$ENVF"; then
    # In the same directory, so the mv is an atomic rename; the EXIT handler removes it if we die
    # first. The env file itself is never truncated in place.
    ENV_TMP="$(mktemp "$ENVF.XXXXXX")"
    { grep -v "^$1=" "$ENVF" || true; echo "$1=$2"; } > "$ENV_TMP"
    mv "$ENV_TMP" "$ENVF"; ENV_TMP=""
  else echo "$1=$2" >> "$ENVF"; fi
}

SECRET_KEYS="POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN"

# rand_hex BYTES VAR: a random hex string into VAR. A command substitution inside echo would hide an
# openssl failure from set -e and leave an empty secret, so it is assigned and checked here.
rand_hex() {
  local v; v="$(openssl rand -hex "$1" 2>/dev/null)" || v=""
  [ -n "$v" ] || die "cannot generate a random secret: 'openssl rand' is missing or failed; install openssl and run again (no env file was written)" 2
  printf -v "$2" '%s' "$v"
}

genenv() {
  need nc openssl; need_compose
  mkdir -p "$STAGE"
  if [ ! -f "$ENVF" ]; then
    say "env: generating dozo/.stage/dozo.env (random secrets, not printed)"
    local pg pga ba ek sp st
    rand_hex 16 pg; rand_hex 16 pga; rand_hex 32 ba; rand_hex 32 ek; rand_hex 32 sp; rand_hex 32 st
    # Written whole into a temp file and moved in, so an interrupted run leaves no half-written file.
    ( umask 077
      printf '%s\n' "POSTGRES_PASSWORD=$pg" "POSTGRES_APP_PASSWORD=$pga" "BETTER_AUTH_SECRET=$ba" \
        "ENCRYPTION_KEY=$ek" "SCREEN_PROXY_SECRET=$sp" "SANDBOX_SUPERVISOR_TOKEN=$st" \
        "RAKAZO_WEB_BIND=127.0.0.1" > "$ENVF.new" && mv "$ENVF.new" "$ENVF" ) || die "cannot write $ENVF"
  else
    # By key only: the value is tested for being non-empty and never read out.
    local k bad=""
    for k in $SECRET_KEYS; do grep -q "^$k=." "$ENVF" || bad="$bad $k"; done
    [ -z "$bad" ] || die "$ENVF has an empty or missing secret:$bad. An older run without openssl wrote it. If the database volume is new or disposable: build.sh down --volumes && rm that file, then run again; otherwise set those keys by hand" 2
  fi
  # Our stack binds to 127.0.0.1 on the user's own machine, so private model endpoints (a local
  # OpenAI-compatible server) are allowed. Reaches api and worker through upstream's x-app-environment.
  setenv MCP_ALLOW_PRIVATE_ENDPOINT true
  # Keep the port if our own web container is running; otherwise pick a free one, starting from
  # DOZO_WEB_PORT of the caller (a seed only: once the file has the port, the file decides).
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
  # 'computer' (the sandbox image, what sandbox:build builds) is a compose service like the rest: a
  # separate first pass only repeated it as a cache hit.
  say "build: all images, one at a time (Docker VM memory is limited)"
  COMPOSE_PARALLEL_LIMIT=1 dc build
  say "build: ok"
  # Rebuilds leave the previous layers untagged. `image prune` without -a touches dangling images
  # only, and the label limits it to what compose built for this project (the base images and other
  # projects' images do not carry it), so nothing else on the machine is removed.
  docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" | sed -n 's/^Total reclaimed space/[dozo] build: pruned dangling images, reclaimed/p' \
    || say "build: image prune skipped (docker refused it)"
  dc config --images | sort -u | sed 's/^/[dozo] image: /'
}

up() {
  STEP=up; need_stage; need curl; genenv
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
  STEP=smoke; need curl; genenv
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
  STEP=down; need_stage; need_compose
  say "down: project '$PROJECT'${VOLUMES:+ (with volumes)}"
  dc down ${DOZO_STOP_TIMEOUT:+--timeout "$DOZO_STOP_TIMEOUT"} ${VOLUMES:+--volumes}
}

usage() { echo "usage: $0 [stage|brand|build|up|smoke|down|all] [--volumes (down only)]" >&2; exit 64; }
CMD="${1:-all}"; VOLUMES=""
[ $# -eq 0 ] || shift
# Anything but the one documented flag is refused: `down --volume` (typo) must not run a plain down.
for a in "$@"; do
  [ "$a" = "--volumes" ] && [ "$CMD" = down ] && VOLUMES=1 || usage
done
case "$CMD" in
  stage) stage ;; brand) brand ;; build) build ;; up) up ;; smoke) smoke ;; down) down ;;
  all) stage; brand; build; up ;;
  *) usage ;;
esac
