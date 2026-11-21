#!/usr/bin/env bash
# The fork's Postgres tests (every dozo-*.postgres.test.ts) on the branded stage, against a
# throwaway Postgres, once per session time zone. The local server's Postgres runs on the person's
# own machine, where it may take that machine's zone; fork SQL must give the same answer in every
# zone, so each run sets the database's TimeZone and the test process's TZ to it.
# Run it on a branded stage:
#   dozo/docker/build.sh stage && dozo/docker/build.sh brand && dozo/docker/postgres-tests.sh
# DOZO_PG_ZONES (default "UTC Europe/Istanbul America/Los_Angeles"), DOZO_STAGE_DIR, DOZO_NODE_IMAGE,
# DOZO_POSTGRES_IMAGE. Logs: <stage>/postgres-tests/. The pnpm store is kept in the volume
# dozo-postgres-tests-store. Last line POSTGRES: PASS|FAIL. Exit 0, 2 failed, 64 usage.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STAGE="${DOZO_STAGE_DIR:-$ROOT/dozo/.stage}"
case "$STAGE" in /*) ;; *) STAGE="$PWD/${STAGE#./}" ;; esac
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"
PG_IMAGE="${DOZO_POSTGRES_IMAGE:-postgres:18-alpine}"
ZONES="${DOZO_PG_ZONES:-UTC Europe/Istanbul America/Los_Angeles}"
OUT="$STAGE/postgres-tests"
STORE=dozo-postgres-tests-store
RUN_ID="pgt-$$"
NET="dozo-$RUN_ID"
DB="dozo-$RUN_ID-db"
NODE="dozo-$RUN_ID-node"

die() { echo "[postgres] $1" >&2; echo "POSTGRES: FAIL ($1)"; exit 2; }
cleanup() {
  local rc=$?
  # Only what this run started, by name.
  docker rm -f "$NODE" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ $rc -eq 0 ] || [ $rc -eq 64 ] || rc=2
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

[ $# -eq 0 ] || { echo "usage: $0 (no arguments; DOZO_PG_ZONES, DOZO_STAGE_DIR, DOZO_NODE_IMAGE, DOZO_POSTGRES_IMAGE)" >&2; exit 64; }
command -v docker >/dev/null || die "docker not found"
[ -f "$STAGE/stage.complete" ] && [ -f "$STAGE/src/package.json" ] \
  || die "no branded stage: run dozo/docker/build.sh stage and dozo/docker/build.sh brand first"
files=$(cd "$STAGE/src" && find apps packages \( -name node_modules -prune \) -o -type f -name 'dozo-*.postgres.test.ts' -print | sort)
[ -n "$files" ] || die "no dozo-*.postgres.test.ts files on the stage"

rm -rf "$OUT"; mkdir -p "$OUT"
docker network create "$NET" >/dev/null
# The server's own default stays UTC, as Docker's image sets it; each zone is set on its database.
docker run -d --rm --name "$DB" --network "$NET" --cpus 1 --memory 1g \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rakazo \
  "$PG_IMAGE" postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null

# shellcheck disable=SC2016,SC2086  # the script is expanded by the container's shell
docker run --init --rm --name "$NODE" --network "$NET" --cpus 3 --memory 6g \
  -v "$STAGE/src:/src:ro" -v "$STORE:/store" -v "$OUT:/out" -e CI=1 -e DB="$DB" -e ZONES="$ZONES" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e COREPACK_HOME=/store/corepack -e OWNER="$(id -u):$(id -g)" \
  "$NODE_IMAGE" sh -c '
    set -e
    trap "chown -R \"\$OWNER\" /out" EXIT
    mkdir /w && (cd /src && tar -cf - --exclude=./node_modules .) | tar -C /w -xf - && cd /w
    corepack enable
    pnpm install --frozen-lockfile --store-dir /store/pnpm --loglevel=warn >/out/install.log 2>&1 \
      || { tail -20 /out/install.log; exit 3; }
    pnpm --filter @rakazo/db generate >/out/generate.log 2>&1 || { tail -20 /out/generate.log; exit 3; }
    owner="postgres://postgres:postgres@$DB:5432"
    app="postgres://rakazo_app:rakazo-test-runtime@$DB:5432"
    sql() { (cd packages/db && node -e "
      const { Client } = require(\"pg\");
      (async () => {
        for (let i = 0; ; i++) {
          const client = new Client({ connectionString: process.argv[1] });
          try { await client.connect(); await client.query(process.argv[2]); await client.end(); return; }
          catch (error) { await client.end().catch(() => {}); if (i >= 60) throw error; await new Promise((r) => setTimeout(r, 1000)); }
        }
      })().catch((error) => { console.error(String(error)); process.exit(1); });" "$1" "$2"); }
    sql "$owner/rakazo" "SELECT 1"
    DATABASE_MIGRATION_URL="$owner/rakazo" DATABASE_URL="$app/rakazo" pnpm db:migrate >/out/migrate.log 2>&1 \
      || { tail -20 /out/migrate.log; exit 3; }
    rc=0
    for zone in $ZONES; do
      name=$(printf %s "$zone" | tr -c "A-Za-z0-9" _ | tr A-Z a-z)
      sql "$owner/postgres" "CREATE DATABASE tz_$name TEMPLATE rakazo"
      sql "$owner/postgres" "ALTER DATABASE tz_$name SET timezone TO '\''$zone'\''"
      echo "[postgres] >> $zone"
      if TZ="$zone" VERIFY_DATABASE=1 DATABASE_URL="$app/tz_$name" DATABASE_MIGRATION_URL="$owner/tz_$name" \
        node node_modules/vitest/vitest.mjs run --maxWorkers=3 --reporter=default \
        --reporter=json --outputFile.json="/out/$name.json" "$@" >"/out/$name.log" 2>&1; then
        :
      else rc=2; fi
      # Every file runs only with a database: a skipped test means the run did not reach it.
      node -e "
        const r = require(process.argv[1]);
        const skipped = r.numPendingTests + r.numTodoTests;
        console.log(\`[postgres] << \${process.argv[2]}: \${r.numPassedTests} passed, \${r.numFailedTests} failed, \${skipped} skipped\`);
        if (r.numPassedTests === 0 || r.numFailedTests > 0 || skipped > 0) process.exit(2);" \
        "/out/$name.json" "$zone" || { rc=2; grep -E "FAIL|AssertionError|Error:|expected" "/out/$name.log" | head -40; }
    done
    exit $rc' _ $files || die "a test failed or did not run (logs in $OUT)"
echo "POSTGRES: PASS ($(printf '%s\n' "$files" | grep -c .) files in $(printf '%s ' $ZONES))"
