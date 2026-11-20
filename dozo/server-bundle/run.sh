#!/usr/bin/env bash
# Starts and stops the local server from an unpacked bundle as plain processes: the reference for
# the start contract the desktop app follows (README.md, "Start contract"). Linux and macOS.
# Usage: run.sh preflight|start|stop
#   DOZO_RUNTIME  folder with node/ (Node), postgres/ (Postgres) and server/rakazo-server/
#   DOZO_HOME     the user's state: secrets.env (0600), pgdata/, data/, logs/, run/*.pid
#   DOZO_PG_PORT (54329), DOZO_API_PORT (3100), DOZO_WEB_PORT (5173): all on 127.0.0.1 only
# start: secrets on first run, initdb, Postgres, migrate, then api, worker and web; returns once
#   the API's /health and the web page answer 200 (at most 120 s). Prints `ready <web-url>`.
# stop: web, worker, api with TERM (10 s each), then Postgres fast shutdown.
# Exit 0 ok; 2 failed (also a stop that had to KILL); 64 usage.
set -euo pipefail

die() { echo "[run] FAILED: $*" >&2; exit 2; }
say() { echo "[run] $*"; }
ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# Prisma's migration engine on Linux loads the system OpenSSL 3 (libssl.so.3); the bundle does not
# carry it. Every current desktop distribution has it; a bare container may not.
preflight() {
  [ "$(uname -s)" = Linux ] || return 0
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libssl\.so\.3 '; then return 0; fi
  local dir
  for dir in /lib /lib64 /usr/lib /usr/lib64 /lib/*-linux-gnu /usr/lib/*-linux-gnu; do
    [ ! -e "$dir/libssl.so.3" ] || return 0
  done
  die "libssl3 (OpenSSL 3) is not installed. The database migration needs it. Install it, for example: sudo apt install libssl3 (Debian, Ubuntu) or sudo dnf install openssl-libs (Fedora), then start again."
}

setup() {
  R="${DOZO_RUNTIME:?DOZO_RUNTIME is not set}"
  H="${DOZO_HOME:?DOZO_HOME is not set}"
  SERVER="$R/server/rakazo-server"
  PG="$R/postgres/bin"
  PG_PORT="${DOZO_PG_PORT:-54329}" API_PORT="${DOZO_API_PORT:-3100}" WEB_PORT="${DOZO_WEB_PORT:-5173}"
  WEB="http://127.0.0.1:$WEB_PORT"
  export PATH="$R/node/bin:$PATH"
  [ -x "$R/node/bin/node" ] && [ -x "$PG/postgres" ] && [ -f "$SERVER/manifest.json" ] \
    || die "DOZO_RUNTIME is missing node/bin/node, postgres/bin/postgres or server/rakazo-server/manifest.json"
  mkdir -p "$H/logs" "$H/data" "$H/run"
}

# A path the entrypoint map in the bundle's manifest.json names.
entry() { node -e 'process.stdout.write(require(process.argv[1]).entrypoints[process.argv[2]])' "$SERVER/manifest.json" "$1"; }
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
status() { node -e 'fetch(process.argv[1]).then((r) => console.log(r.status), () => console.log(0))' "$1"; }

start() {
  preflight; setup
  local t0 first=0 key
  t0=$(ms)
  if [ ! -f "$H/secrets.env" ]; then
    (umask 077; for key in PG_OWNER_PASSWORD PG_APP_PASSWORD BETTER_AUTH_SECRET SCREEN_PROXY_SECRET ENCRYPTION_KEY STACK_TOKEN; do
      echo "$key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    done > "$H/secrets.env")
  fi
  set -a; . "$H/secrets.env"; set +a
  if [ ! -d "$H/pgdata" ]; then
    first=1
    (umask 077; printf '%s' "$PG_OWNER_PASSWORD" > "$H/run/pwfile")
    "$PG/initdb" -D "$H/pgdata" -U rakazo --pwfile="$H/run/pwfile" -A scram-sha-256 -E UTF8 --locale=C \
      > "$H/logs/initdb.log" 2>&1 || { rm -f "$H/run/pwfile"; die "initdb failed (logs/initdb.log)"; }
    rm -f "$H/run/pwfile"
  fi
  # TCP on loopback only; no Unix socket, whose path length the user's folder could exceed.
  "$PG/pg_ctl" -D "$H/pgdata" -l "$H/logs/postgres.log" -w -t 60 \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=" start > /dev/null \
    || die "Postgres did not start (logs/postgres.log)"
  if [ $first = 1 ]; then
    PGPASSWORD="$PG_OWNER_PASSWORD" "$PG/createdb" -h 127.0.0.1 -p "$PG_PORT" -U rakazo rakazo \
      || die "createdb failed"
  fi
  local owner_url app_url
  owner_url="postgres://rakazo:$(urlenc "$PG_OWNER_PASSWORD")@127.0.0.1:$PG_PORT/rakazo"
  app_url="postgres://rakazo_app:$(urlenc "$PG_APP_PASSWORD")@127.0.0.1:$PG_PORT/rakazo"
  local base=(NODE_ENV=production RAKAZO_ENV_FILE=none PATH="$PATH" HOME="$H")
  cd "$SERVER"
  env -i "${base[@]}" DATABASE_URL="$app_url" DATABASE_MIGRATION_URL="$owner_url" RAKAZO_DB_PACKAGE_DIR=packages/db \
    node "$(entry migrate)" > "$H/logs/migrate.log" 2>&1 || die "migration failed (logs/migrate.log)"
  local app=(DATABASE_URL="$app_url" DATA_DIR="$H/data" SANDBOX_PROVIDER=none CONTENT_ENCRYPTION=off
    WAKEUP_DRIVER=graphile AGENT_RUNTIME=pi MCP_ALLOW_PRIVATE_ENDPOINT=true BETTER_AUTH_URL="$WEB"
    WEB_ORIGIN="$WEB" API_URL="$WEB" RAKAZO_DESKTOP_STACK_TOKEN="$STACK_TOKEN"
    SCREEN_PROXY_SECRET="$SCREEN_PROXY_SECRET" BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" ENCRYPTION_KEY="$ENCRYPTION_KEY")
  env -i "${base[@]}" "${app[@]}" API_HOST=127.0.0.1 API_PORT="$API_PORT" AUTH_PASSWORD_ENABLED=true \
    AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false node "$(entry api)" > "$H/logs/api.log" 2>&1 &
  echo $! > "$H/run/api.pid"
  env -i "${base[@]}" "${app[@]}" node "$(entry worker)" > "$H/logs/worker.log" 2>&1 &
  echo $! > "$H/run/worker.pid"
  env -i "${base[@]}" API_PROXY_TARGET="http://127.0.0.1:$API_PORT" SCREEN_PROXY_SECRET="$SCREEN_PROXY_SECRET" \
    WEB_HOST=127.0.0.1 WEB_PORT="$WEB_PORT" RAKAZO_DESKTOP_STACK_TOKEN="$STACK_TOKEN" \
    RAKAZO_IMAGE_TAG="$(node -p 'require("./manifest.json").version')" node "$(entry web)" > "$H/logs/web.log" 2>&1 &
  echo $! > "$H/run/web.pid"
  local i a=0 w=0
  for i in $(seq 1 240); do
    a=$(status "http://127.0.0.1:$API_PORT/health"); w=$(status "$WEB/")
    [ "$a" = 200 ] && [ "$w" = 200 ] && break
    sleep 0.5
  done
  [ "$a" = 200 ] && [ "$w" = 200 ] || die "not ready after 120 s (api $a, web $w; logs/api.log, logs/web.log)"
  say "started in $(( $(ms) - t0 )) ms$([ $first = 0 ] || echo ', first run')"
  echo "ready $WEB"
}

stop() {
  setup
  local p pid i rc=0
  for p in web worker api; do
    [ -f "$H/run/$p.pid" ] || continue
    pid=$(cat "$H/run/$p.pid")
    if kill -TERM "$pid" 2>/dev/null; then
      for i in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; say "$p ignored TERM for 10 s: killed"; rc=2
      else say "$p stopped"; fi
    fi
    rm -f "$H/run/$p.pid"
  done
  if [ -f "$H/pgdata/postmaster.pid" ]; then
    if "$PG/pg_ctl" -D "$H/pgdata" -m fast -w -t 30 stop > /dev/null; then say "postgres stopped"
    else say "postgres did not stop"; rc=2; fi
  fi
  return $rc
}

case "${1:-}" in
  preflight) preflight; say "preflight ok" ;;
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 preflight|start|stop" >&2; exit 64 ;;
esac
