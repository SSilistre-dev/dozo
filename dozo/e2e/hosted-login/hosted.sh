#!/usr/bin/env bash
# The hosted server for the hosted login end-to-end test (README.md): the same server bundle as a
# computer's, started as the hosted service runs (any number of accounts, no desktop marker) and
# with the signing keys. run.sh in dozo/server-bundle is the start contract this follows.
# Usage: hosted.sh start|stop
#   DOZO_RUNTIME (node/, postgres/, server/rakazo-server/), DOZO_HOME (its state), HOSTED_HOST
#   (the name it answers as, default localhost), HOSTED_WEB_PORT, HOSTED_API_PORT, HOSTED_PG_PORT,
#   HOSTED_LOGIN_SIGNING_KEY, HOSTED_LOGIN_OVERLAP_KEY, HOSTED_FAKETIME (an offset such as -10m
#   that only the api's clock sees, through libfaketime).
# Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
die() { echo "[hosted] FAILED: $*" >&2; exit 2; }

R="${DOZO_RUNTIME:?}" H="${DOZO_HOME:?}"
SERVER="$R/server/rakazo-server" PG="$R/postgres/bin"
HOST="${HOSTED_HOST:-localhost}" WEB_PORT="${HOSTED_WEB_PORT:-6173}"
API_PORT="${HOSTED_API_PORT:-3300}" PG_PORT="${HOSTED_PG_PORT:-54529}"
WEB="http://$HOST:$WEB_PORT"
export PATH="$R/node/bin:$PATH"
mkdir -p "$H/logs" "$H/data" "$H/run"
entry() { node -e 'process.stdout.write(require(process.argv[1]).entrypoints[process.argv[2]])' "$SERVER/manifest.json" "$1"; }
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
status() { node -e 'fetch(process.argv[1]).then((r) => console.log(r.status), () => console.log(0))' "$1"; }

start() {
  local key first=0
  if [ ! -f "$H/secrets.env" ]; then
    (umask 077; for key in PG_OWNER_PASSWORD PG_APP_PASSWORD BETTER_AUTH_SECRET SCREEN_PROXY_SECRET ENCRYPTION_KEY; do
      echo "$key=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    done > "$H/secrets.env")
  fi
  set -a; . "$H/secrets.env"; set +a
  if [ ! -d "$H/pgdata" ]; then
    first=1
    (umask 077; printf '%s' "$PG_OWNER_PASSWORD" > "$H/run/pwfile")
    "$PG/initdb" -D "$H/pgdata" -U rakazo --pwfile="$H/run/pwfile" -A scram-sha-256 -E UTF8 --locale=C \
      > "$H/logs/initdb.log" 2>&1 || die "initdb (logs/initdb.log)"
    rm -f "$H/run/pwfile"
  fi
  if [ ! -f "$H/pgdata/postmaster.pid" ]; then
    "$PG/pg_ctl" -D "$H/pgdata" -l "$H/logs/postgres.log" -w -t 60 \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c timezone=UTC" start > /dev/null \
      || die "Postgres (logs/postgres.log)"
  fi
  [ $first = 0 ] || PGPASSWORD="$PG_OWNER_PASSWORD" "$PG/createdb" -h 127.0.0.1 -p "$PG_PORT" -U rakazo rakazo
  local owner_url app_url
  owner_url="postgres://rakazo:$(urlenc "$PG_OWNER_PASSWORD")@127.0.0.1:$PG_PORT/rakazo"
  app_url="postgres://rakazo_app:$(urlenc "$PG_APP_PASSWORD")@127.0.0.1:$PG_PORT/rakazo"
  local base=(NODE_ENV=production RAKAZO_ENV_FILE=none PATH="$PATH" HOME="$H")
  cd "$SERVER"
  if [ $first = 1 ]; then
    env -i "${base[@]}" DATABASE_URL="$app_url" DATABASE_MIGRATION_URL="$owner_url" RAKAZO_DB_PACKAGE_DIR=packages/db \
      node "$(entry migrate)" > "$H/logs/migrate.log" 2>&1 || die "migration (logs/migrate.log)"
  fi
  local clock=()
  [ -z "${HOSTED_FAKETIME:-}" ] || clock=(LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
    FAKETIME="$HOSTED_FAKETIME" FAKETIME_DONT_FAKE_MONOTONIC=1)
  env -i "${base[@]}" "${clock[@]}" DATABASE_URL="$app_url" DATA_DIR="$H/data" SANDBOX_PROVIDER=none \
    CONTENT_ENCRYPTION=off WAKEUP_DRIVER=graphile AGENT_RUNTIME=pi BETTER_AUTH_URL="$WEB" WEB_ORIGIN="$WEB" \
    API_URL="$WEB" SCREEN_PROXY_SECRET="$SCREEN_PROXY_SECRET" BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
    ENCRYPTION_KEY="$ENCRYPTION_KEY" API_HOST=127.0.0.1 API_PORT="$API_PORT" AUTH_PASSWORD_ENABLED=true \
    AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false HOSTED_LOGIN_SIGNING_KEY="${HOSTED_LOGIN_SIGNING_KEY:-}" \
    HOSTED_LOGIN_OVERLAP_KEY="${HOSTED_LOGIN_OVERLAP_KEY:-}" node "$(entry api)" >> "$H/logs/api.log" 2>&1 &
  echo $! > "$H/run/api.pid"
  if [ ! -f "$H/run/web.pid" ]; then
    env -i "${base[@]}" API_PROXY_TARGET="http://127.0.0.1:$API_PORT" SCREEN_PROXY_SECRET="$SCREEN_PROXY_SECRET" \
      WEB_HOST=127.0.0.1 WEB_PORT="$WEB_PORT" RAKAZO_IMAGE_TAG="$(node -p 'require("./manifest.json").version')" \
      node "$(entry web)" >> "$H/logs/web.log" 2>&1 &
    echo $! > "$H/run/web.pid"
  fi
  local i a=0 w=0
  for i in $(seq 1 240); do
    a=$(status "http://127.0.0.1:$API_PORT/health"); w=$(status "http://127.0.0.1:$WEB_PORT/")
    [ "$a" = 200 ] && [ "$w" = 200 ] && break
    sleep 0.5
  done
  [ "$a" = 200 ] && [ "$w" = 200 ] || die "not ready (api $a, web $w)"
  echo "[hosted] ready $WEB"
}

# Only the api: its keys and clock change between steps while the database and the web app stay.
restart_api() {
  if [ -f "$H/run/api.pid" ]; then
    kill -TERM "$(cat "$H/run/api.pid")" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$(cat "$H/run/api.pid")" 2>/dev/null || break; sleep 0.2; done
    rm -f "$H/run/api.pid"
  fi
  start
}

stop() {
  local p
  for p in web api; do
    [ -f "$H/run/$p.pid" ] || continue
    kill -TERM "$(cat "$H/run/$p.pid")" 2>/dev/null || true
    rm -f "$H/run/$p.pid"
  done
  [ ! -f "$H/pgdata/postmaster.pid" ] || "$PG/pg_ctl" -D "$H/pgdata" -m fast -w -t 30 stop > /dev/null
}

case "${1:-}" in
  start) start ;;
  restart-api) restart_api ;;
  stop) stop ;;
  *) echo "usage: $0 start|restart-api|stop" >&2; exit 64 ;;
esac
