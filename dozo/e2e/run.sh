#!/usr/bin/env bash
# Runs the Dozo e2e suite in the official Playwright image against the running stack.
# Exit 0 pass, 2 on any failure (stack unreachable, a failed test, zero tests run).
# Output and run-time files are deleted at the end unless DOZO_E2E_KEEP=1.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SUITE="${DOZO_E2E_SUITE:-$HERE}"
OUT="$HERE/.out"
# The stage the stack was built from (as gate.sh resolves it): its dozo.env holds the web port the
# stack actually got, which is not 5173 when that one was busy.
STAGE="${DOZO_STAGE_DIR:-$REPO/dozo/.stage}"
case "$STAGE" in /*) ;; *) STAGE="$PWD/${STAGE#./}" ;; esac
# The generated env file is the one source of truth for the port (build.sh gives compose that file
# alone); an exported DOZO_WEB_PORT is only the fallback when there is no file yet. Only this key
# is read: the file also holds secrets.
WEBPORT=""
if [ -f "$STAGE/dozo.env" ]; then WEBPORT="$(grep -m1 '^DOZO_WEB_PORT=' "$STAGE/dozo.env" | cut -d= -f2)"; fi
[ -n "$WEBPORT" ] || WEBPORT="${DOZO_WEB_PORT:-}"
case "$WEBPORT" in ''|*[!0-9]*) WEBPORT=5173 ;; esac
BASE="${DOZO_E2E_BASE_URL:-http://127.0.0.1:$WEBPORT}"
# Names unique to this run, so a killed run's leftovers never collide with the next one; the label
# lets the one cleanup handler find them all.
RUN_ID="e2e-$$"
NAME="dozo-pw-e2e-$$"
MODEL="dozo-e2e-model-$$"
LOCK="${TMPDIR:-/tmp}/dozo-e2e-$(id -u).lock"   # a directory holding `owner`: "<pid> <start time>" (lock.sh)
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"

say() { printf 'e2e: %s\n' "$*" >&2; }

for tool in docker curl; do command -v "$tool" >/dev/null || { say "$tool not found"; exit 2; }; done

# Every container: --init (so TERM reaches PID 1), a unique name, the run's label. $1 = the name.
drun() { local n="$1"; shift; docker run --init --rm --name "$n" --label "dozo.run=$RUN_ID" "$@"; }
# Wait until $1 is gone, however many trapped signals cut a `wait` short (status in WAIT_RC). `wait`
# runs at least once, so a child that failed and was reaped before the first check keeps its status;
# the extra wait after a status above 128 is explained at wait_gone in dozo/docker/gate.sh.
WAIT_RC=0
wait_gone() {
  local rc again
  while :; do wait "$1"; rc=$?; kill -0 "$1" 2>/dev/null || break; done
  if [ "$rc" -gt 128 ]; then wait "$1"; again=$?; [ "$again" -eq 127 ] || rc=$again; fi
  WAIT_RC=$rc
}

# The output directory and the saved session are shared by every run: a second run would wipe the
# first one's files, so refuse instead (the lock: dozo/docker/lock.sh). Taken before the cleanup trap
# exists, which would otherwise release the running one's lock on this early exit.
# shellcheck source=SCRIPTDIR/../docker/lock.sh
. "$HERE/../docker/lock.sh"
lock_acquire "$LOCK" "e2e run" "e2e:" || exit 2

cleanup() {
  local ids f
  trap '' INT TERM; trap - EXIT   # a second signal must not cut the cleanup short
  ids=(); while IFS= read -r f; do ids+=("$f"); done < <(docker ps -aq --filter "label=dozo.run=$RUN_ID" 2>/dev/null)
  [ "${#ids[@]}" -eq 0 ] || docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
  # The lock goes last: it is what keeps another run out of $OUT and node_modules until they are cleared.
  # Each scenario's last screen outlives the run: dozo/.stage/e2e/shots (replaced every run).
  if [ -d "$OUT/shots" ]; then
    rm -rf "$REPO/dozo/.stage/e2e/shots" && mkdir -p "$REPO/dozo/.stage/e2e" \
      && cp -R "$OUT/shots" "$REPO/dozo/.stage/e2e/shots" && say "screenshots: dozo/.stage/e2e/shots"
  fi
  if [ "${DOZO_E2E_KEEP:-}" = 1 ]; then say "kept $OUT (DOZO_E2E_KEEP=1)"
  else
    [ -d "$OUT" ] && find "$OUT" -mindepth 1 -delete 2>/dev/null
    rm -rf "$HERE/node_modules"
  fi
  lock_release
  return 0
}
trap cleanup EXIT
trap 'exit 2' INT TERM   # the run is in the background and waited for, so this fires at once

# The image tag is the Playwright version upstream pins.
VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$REPO/apps/web/package.json" | head -1)"
[ -n "$VERSION" ] || { say "cannot read the pinned Playwright version"; exit 2; }
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

# The inventory check reads the web app's router and settings source: mount the branded tree the
# stack was built from. The committed apps/web/src is unbranded, so there is no fallback to it.
WEBSRC="$STAGE/src/apps/web/src"
[ -f "$STAGE/stage.complete" ] && [ -f "$WEBSRC/App.tsx" ] || { say "no complete staged tree at $STAGE/src (apps/web/src/App.tsx or the stage.complete marker missing); start the stack with: make up"; exit 2; }

code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" || true)"
[ "$code" = 200 ] || { say "stack not reachable at $BASE (HTTP ${code:-none}); start it with: make up"; exit 2; }

mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete

# The offline model: a dependency-free OpenAI-compatible server (model-stub.mjs) in a throwaway
# container on the stack's own network, so the api and worker containers reach it as a local model
# server. Its address is a private IP literal on purpose: the app accepts a private endpoint only
# as an IP, localhost or host.docker.internal (never a hostname that resolves to a private address).
# The api container of the project build.sh runs ("dozo"), found by its compose labels, not by a name.
API="$(docker ps -q --filter label=com.docker.compose.project=dozo --filter label=com.docker.compose.service=api | head -n1)"
[ -n "$API" ] || { say "no running api container in project dozo; start the stack with: make up"; exit 2; }
NETWORK="$(docker inspect "$API" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null | awk '{print $1}')"
[ -n "$NETWORK" ] || { say "cannot read the network of the api container; start the stack with: make up"; exit 2; }
drun "$MODEL" -d --network "$NETWORK" -e PORT=8787 -v "$HERE:/stub:ro" "$NODE_IMAGE" node /stub/model-stub.mjs >/dev/null \
  || { say "could not start the model stub (is $NODE_IMAGE pulled? docker pull $NODE_IMAGE)"; exit 2; }
MODEL_IP="$(docker inspect "$MODEL" --format "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}")"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  docker exec "$API" node -e "fetch('http://$MODEL_IP:8787/v1/models').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break
  sleep 1
done
docker exec "$API" node -e "fetch('http://$MODEL_IP:8787/v1/models').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null \
  || { say "the api container cannot reach the model stub at $MODEL_IP:8787"; exit 2; }
say "offline model: http://$MODEL_IP:8787/v1 on network $NETWORK"

# The admin of the admin scenarios: the first address in the api's RAKAZO_ADMIN_EMAILS (build.sh
# writes admin@dozo-e2e.test when the env file names none). It is signed up once through the auth
# API and its address marked verified in the database, as an admin's must be; an existing account
# keeps its password. The auth rate limit's rows are cleared, so repeated runs within 15 minutes
# are not refused (production keeps the limit: it is the stack's, cleared only here, locally).
PG="$(docker ps -q --filter label=com.docker.compose.project=dozo --filter label=com.docker.compose.service=postgres | head -n1)"
[ -n "$PG" ] || { say "no running postgres container in project dozo; start the stack with: make up"; exit 2; }
psql_run() { docker exec "$PG" sh -c 'psql -v ON_ERROR_STOP=1 -qtA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' _ "$1"; }
ADMIN_EMAIL="$(docker exec "$API" printenv RAKAZO_ADMIN_EMAILS 2>/dev/null | cut -d, -f1 | tr -d ' ' | tr '[:upper:]' '[:lower:]')"
ADMIN_PASSWORD="dozo-e2e-admin-pass-12"   # a local test account on a loopback stack, not a secret
psql_run 'DELETE FROM "rateLimit"' >/dev/null || { say "cannot clear the auth rate limit in the database"; exit 2; }
if [ -n "$ADMIN_EMAIL" ]; then
  case "$ADMIN_EMAIL" in *[!a-z0-9@.+_-]*) say "unexpected characters in RAKAZO_ADMIN_EMAILS"; exit 2 ;; esac
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$BASE/api/auth/sign-up/email" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"name\":\"E2E Admin\"}" || true)"
  case "$code" in 200|422) ;; *) say "admin sign-up answered HTTP ${code:-none}"; exit 2 ;; esac
  psql_run "UPDATE \"user\" SET \"emailVerified\" = true WHERE lower(email) = '$ADMIN_EMAIL'" >/dev/null \
    || { say "cannot mark the admin's email verified"; exit 2; }
  say "admin: $ADMIN_EMAIL"
else
  say "the api has no RAKAZO_ADMIN_EMAILS: the admin scenarios will fail; run make up again (build.sh adds one)"
fi

# Verification links for flows/verify.spec.ts. The stack sends no mail, so the account is signed up
# here through the auth API and the links its mail would carry are made as the server makes them:
# the link's token (HS256 over the address, with its expiry) and the result page's mark (an HMAC
# over the account id, packages/auth/src/dozo-email-link.ts), signed inside the api container with
# the api's own secret, which is never printed or written. One valid and one expired link, for an
# address only this run uses. The password is a local test account's, like the admin's.
VERIFY_EMAIL="verify-$$-$(date +%s)@example.test"
VERIFY_PASSWORD="dozo-e2e-verify-pass-12"
code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$BASE/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "origin: $BASE" \
  --data "{\"email\":\"$VERIFY_EMAIL\",\"password\":\"$VERIFY_PASSWORD\",\"name\":\"E2E Verify\"}" || true)"
[ "$code" = 200 ] || { say "verification account sign-up answered HTTP ${code:-none}"; exit 2; }
VERIFY_USER="$(psql_run "SELECT id FROM \"user\" WHERE email = '$VERIFY_EMAIL'")"
[ -n "$VERIFY_USER" ] || { say "cannot read the verification account's id"; exit 2; }
verify_link() {
  docker exec -e E="$VERIFY_EMAIL" -e U="$VERIFY_USER" -e X="$1" -e BASE="$BASE" "$API" node -e '
    const c = require("node:crypto");
    const key = process.env.BETTER_AUTH_SECRET;
    if (!key) process.exit(3);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = part({ alg: "HS256", typ: "JWT" }) + "." + part({ email: process.env.E, iat: now - 7200, exp: now + Number(process.env.X) });
    const token = body + "." + c.createHmac("sha256", key).update(body).digest("base64url");
    const payload = Buffer.from(process.env.U).toString("base64url") + "." + (now + 7 * 24 * 3600);
    const mark = payload + "." + c.createHmac("sha256", key).update("dozo-email-link:" + payload).digest("base64url");
    const back = process.env.BASE + "/verify-email?v=" + encodeURIComponent(mark);
    console.log("/api/auth/verify-email?token=" + token + "&callbackURL=" + encodeURIComponent(back));'
}
VERIFY_LINK="$(verify_link 3600)" && VERIFY_EXPIRED="$(verify_link -60)" \
  || { say "cannot make the verification links in the api container"; exit 2; }

# npm's download cache lives in a named Docker volume (nothing on the host); the container runs as
# the invoking user, so the volume is opened for writing. If that fails, run without a cache.
CACHE=(-v "dozo-e2e-npm:/npm" -e npm_config_cache=/npm/cache)
# Opened on every run, not only when created: a volume another tool made is root-owned otherwise.
{ docker volume inspect dozo-e2e-npm >/dev/null 2>&1 || docker volume create dozo-e2e-npm >/dev/null 2>&1; } \
  && drun "dozo-e2e-npm-$$" -v dozo-e2e-npm:/npm "$NODE_IMAGE" chmod -R a+rwX /npm >/dev/null 2>&1 || CACHE=()
REUSE=()
if [ -n "${DOZO_E2E_REUSE_DIR:-}" ]; then REUSE=(-v "$DOZO_E2E_REUSE_DIR:/reuse:ro" -e DOZO_E2E_REUSE_DIR=/reuse); fi

# The app only accepts the origin it was configured with (127.0.0.1:<port>), so the browser must
# reach the stack under that same name. Linux: --network host. Docker Desktop / Colima (macOS): the
# browser container joins the stack's own network and a 5-line forwarder inside it listens on
# 127.0.0.1:<port> and relays to the web service by name, so the browser still sees 127.0.0.1:<port>
# and no request goes through the VM's published-port forwarding, which stalled under many parallel
# page loads. Closing either side of a relayed connection closes the other, so no stream leaks.
PORT="$(printf '%s' "$BASE" | sed -n 's#^https\{0,1\}://[^:/]*:\([0-9]*\).*#\1#p')"
NET=(--network "$NETWORK")
FORWARD=1
if [ "$(uname -s)" = Linux ]; then NET=(--network host); FORWARD=0; fi

# The computer image's own checks that need no stack: the signed-in sites script against a real
# browser, offline (dozo/e2e/site-sessions-image.sh).
say "computer image: signed-in sites script"
"$HERE/site-sessions-image.sh" >&2 || { say "the signed-in sites script failed in the computer image"; exit 2; }
say "browser: docker ($IMAGE), base $BASE, forwarder=$FORWARD"
# The quoted script is expanded by the container's shell, not this one (SC2016).
# shellcheck disable=SC2016
drun "$NAME" --cpus "${DOZO_E2E_CPUS:-3}" --memory "${DOZO_E2E_MEMORY:-6g}" --ipc=host --user "$(id -u):$(id -g)" "${NET[@]}" \
  -e HOME=/tmp -e DOZO_E2E_BASE_URL="$BASE" -e DOZO_E2E_OUT=/out \
  -e DOZO_E2E_ARGS="${DOZO_E2E_ARGS:-}" -e FORWARD="$FORWARD" -e PORT="${PORT:-80}" -e VERSION="$VERSION" \
  -e DOZO_E2E_MODEL_URL="http://$MODEL_IP:8787/v1" -e DOZO_E2E_SRC=/webapp-src \
  -e DOZO_E2E_ADMIN_EMAIL="$ADMIN_EMAIL" -e DOZO_E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e DOZO_E2E_VERIFY_EMAIL="$VERIFY_EMAIL" -e DOZO_E2E_VERIFY_PASSWORD="$VERIFY_PASSWORD" \
  -e DOZO_E2E_VERIFY_LINK="$VERIFY_LINK" -e DOZO_E2E_VERIFY_EXPIRED="$VERIFY_EXPIRED" \
  -v "$SUITE:/suite:ro" -v "$OUT:/out" -v "$WEBSRC:/webapp-src:ro" ${REUSE[@]+"${REUSE[@]}"} ${CACHE[@]+"${CACHE[@]}"} \
  "$IMAGE" bash -c '
    set -e
    mkdir /tmp/work && cd /tmp/work
    tar --warning=no-file-changed -C /suite --exclude=.out --exclude=node_modules -cf - . | tar -xf -
    # The installed modules live in the cache volume, keyed by a hash of the package spec, so a
    # changed spec installs into a new directory and other keys are removed. Without the volume
    # (/npm absent) they are installed per run into the container, as before.
    spec="@playwright/test@$VERSION"
    base=/npm/mods; [ -d /npm ] || base=/tmp/mods
    mods="$base/$(printf %s "$spec" | sha256sum | cut -c1-16)"
    if [ ! -d "$mods/node_modules/@playwright/test" ]; then
      mkdir -p "$base"; find "$base" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      # Not an && chain: set -e ignores a failure inside one, and the run would end in "zero tests ran".
      mkdir "$mods.tmp"
      if ! (cd "$mods.tmp" && npm install --prefer-offline --no-save --no-audit --no-fund --no-package-lock --loglevel=error "$spec" >/dev/null); then
        rm -rf "$mods.tmp"; echo "e2e: npm install of $spec failed" >&2; exit 2
      fi
      mv "$mods.tmp" "$mods"
    fi
    ln -s "$mods/node_modules" node_modules
    if [ "$FORWARD" = 1 ]; then
      node -e "const net=require(\"net\");net.createServer(c=>{const u=net.connect(5173,\"web\");c.pipe(u);u.pipe(c);const e=()=>{c.destroy();u.destroy()};c.on(\"error\",e);u.on(\"error\",e);c.on(\"close\",e);u.on(\"close\",e)}).listen(+process.env.PORT,\"127.0.0.1\")" &
      fwd=$!
      # Wait for the port (at most 10 s) instead of a fixed sleep; a forwarder that died is an error.
      up=0
      for _ in $(seq 1 50); do
        kill -0 "$fwd" 2>/dev/null || break
        if (: < /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then up=1; break; fi
        sleep 0.2
      done
      [ "$up" = 1 ] || { echo "e2e: the forwarder is not listening on 127.0.0.1:$PORT" >&2; exit 2; }
    fi
    set +e
    # shellcheck disable=SC2086
    npx playwright test $DOZO_E2E_ARGS
    rc=$?
    set -e
    # Zero tests ran (everything skipped or filtered) counts as a failure.
    ran=$(node -e "const s=require(\"/out/results.json\").stats;console.log(s.expected+s.unexpected+s.flaky)" 2>/dev/null || echo 0)
    [ "$ran" -gt 0 ] || { echo "e2e: zero tests ran" >&2; exit 2; }
    exit $rc
  ' &
wait_gone $!; rc=$WAIT_RC
if [ "$rc" -eq 0 ]; then say "PASS"
else say "FAIL (docker/playwright exit $rc)"; exit 2
fi
