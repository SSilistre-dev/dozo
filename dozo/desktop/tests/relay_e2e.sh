#!/usr/bin/env bash
# The bot's browser over the real relay, on Linux: a throwaway Postgres migrated as the server's,
# the server's own device hub, gateway and browser approval in a Node container
# (packages/adapters/src/dozo-user-browser.relay.test.ts), and this app's own runner connecting to
# it over its socket in a Rust container (device_socket.rs, e2e_relay_forgotten_reaches_this_computer).
# It shows the server's `forgotten` reaching the computer and taking the cleared mark, also when two
# runs of the same bot ask at once, and a sign-in the card allowed reaching the computer (its dialog
# answered Done by the test). The desktop image needs Xvfb as well as a browser.
# Run on a branded stage: dozo/docker/build.sh stage && dozo/docker/build.sh brand && $0
# DOZO_RELAY_DESKTOP_IMAGE: a Linux desktop build image with a Chromium-family browser installed
# (default dozo-desktop-linux:22.04). DOZO_STAGE_DIR, DOZO_NODE_IMAGE, DOZO_POSTGRES_IMAGE as for
# dozo/docker/postgres-tests.sh. Last line RELAY: PASS|FAIL. Exit 0, 2 failed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
PG_IMAGE="${DOZO_POSTGRES_IMAGE:-postgres:18-alpine}"
DESKTOP_IMAGE="${DOZO_RELAY_DESKTOP_IMAGE:-dozo-desktop-linux:22.04}"
STORE=dozo-postgres-tests-store
RUN_ID="relay-$$"
NET="dozo-$RUN_ID"
DB="dozo-$RUN_ID-db"
NODE="dozo-$RUN_ID-node"
APP="dozo-$RUN_ID-app"
SHARED="$(mktemp -d)"
OUT="$STAGE/relay-e2e"

die() { echo "[relay] $1" >&2; echo "RELAY: FAIL ($1)"; exit 2; }
cleanup() {
  local rc=$?
  # Only what this run started, by name.
  docker rm -f "$NODE" "$APP" "$DB" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  rm -rf "$SHARED"
  [ $rc -eq 0 ] || rc=2
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

[ -f "$STAGE/stage.complete" ] || die "no branded stage: run dozo/docker/build.sh stage and brand first"
rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$SHARED"
docker network create "$NET" > /dev/null
docker run -d --rm --name "$DB" --network "$NET" --cpus 1 --memory 1g \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rakazo \
  "$PG_IMAGE" postgres -c fsync=off > /dev/null

# The computer: this app's runner, built and run as build-linux.sh builds it.
docker run --rm --name "$APP" --network "$NET" --cpus 3 --memory 6g -u "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined --shm-size=1g \
  -v "$ROOT/dozo:/dozo" -v "$SHARED:/relay" -w /dozo/desktop -e HOME=/tmp -e CARGO_BUILD_JOBS=3 \
  -e RUSTUP_HOME=/dozo/desktop/.toolchain/linux/rustup -e CARGO_HOME=/dozo/desktop/.toolchain/linux/cargo \
  -e DOZO_RELAY_DIR=/relay -e DOZO_RELAY_SERVER="http://$NODE:8790" \
  "$DESKTOP_IMAGE" bash -c 'export PATH="$CARGO_HOME/bin:$PATH"
    # The sign-in opens the bot'"'"'s browser in a window: a screen for it.
    Xvfb :87 -screen 0 1280x800x24 > /dev/null 2>&1 & export DISPLAY=:87; sleep 1
    cargo test --locked -- --ignored --exact \
    device_socket::tests::e2e_relay_forgotten_reaches_this_computer --nocapture' > "$OUT/computer.log" 2>&1 &
app=$!

# The server: its own hub, gateway and approval, on a migrated database.
# shellcheck disable=SC2016  # expanded by the container's shell
docker run --init --rm --name "$NODE" --network "$NET" --cpus 3 --memory 6g \
  -v "$STAGE/src:/src:ro" -v "$STORE:/store" -v "$SHARED:/relay" -e CI=1 -e DB="$DB" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e COREPACK_HOME=/store/corepack \
  "$NODE_IMAGE" sh -c '
    set -e
    mkdir /w && (cd /src && tar -cf - --exclude=./node_modules .) | tar -C /w -xf - && cd /w
    corepack enable
    pnpm install --frozen-lockfile --store-dir /store/pnpm --loglevel=warn > /tmp/install.log 2>&1 \
      || { tail -20 /tmp/install.log; exit 3; }
    pnpm --filter @rakazo/db generate > /tmp/generate.log 2>&1 || { tail -20 /tmp/generate.log; exit 3; }
    owner="postgres://postgres:postgres@$DB:5432/rakazo"
    app="postgres://rakazo_app:rakazo-test-runtime@$DB:5432/rakazo"
    for i in $(seq 60); do
      (cd packages/db && node -e "const{Client}=require(\"pg\");const c=new Client({connectionString:process.argv[1]});c.connect().then(()=>c.end()).catch(()=>process.exit(1))" "$owner") && break
      sleep 1
    done
    DATABASE_MIGRATION_URL="$owner" DATABASE_URL="$app" pnpm db:migrate > /tmp/migrate.log 2>&1 \
      || { tail -20 /tmp/migrate.log; exit 3; }
    DOZO_RELAY_DIR=/relay DOZO_RELAY_PORT=8790 VERIFY_DATABASE=1 DATABASE_URL="$app" \
      node node_modules/vitest/vitest.mjs run packages/adapters/src/dozo-user-browser.relay.test.ts' \
  > "$OUT/server.log" 2>&1 || { tail -30 "$OUT/server.log"; die "the server side failed (logs in $OUT)"; }

wait "$app" || { tail -30 "$OUT/computer.log"; die "the computer side failed (logs in $OUT)"; }
grep -h 'E2E: relay' "$OUT/server.log" "$OUT/computer.log"
echo "RELAY: PASS"
