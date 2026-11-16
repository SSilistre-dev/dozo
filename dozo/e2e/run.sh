#!/usr/bin/env bash
# Runs the Dozo e2e suite in the official Playwright image against the running stack.
# Exit 0 pass, 2 on any failure (stack unreachable, a failed test, zero tests run).
# Output and run-time files are deleted at the end unless DOZO_E2E_KEEP=1.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SUITE="${DOZO_E2E_SUITE:-$HERE}"
OUT="$HERE/.out"
BASE="${DOZO_E2E_BASE_URL:-http://127.0.0.1:${DOZO_WEB_PORT:-5173}}"
NAME="dozo-pw-e2e"
MODEL="dozo-e2e-model"

say() { printf 'e2e: %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$NAME" "$MODEL" >/dev/null 2>&1 || true
  if [ "${DOZO_E2E_KEEP:-}" = 1 ]; then say "kept $OUT (DOZO_E2E_KEEP=1)"; return; fi
  [ -d "$OUT" ] && find "$OUT" -mindepth 1 -delete 2>/dev/null
  rm -rf "$HERE/node_modules"
  return 0
}
trap cleanup EXIT
trap 'exit 2' INT TERM

# The image tag is the Playwright version upstream pins.
VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$REPO/apps/web/package.json" | head -1)"
[ -n "$VERSION" ] || { say "cannot read the pinned Playwright version"; exit 2; }
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

command -v docker >/dev/null || { say "docker not found"; exit 2; }
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/" || true)"
[ "$code" = 200 ] || { say "stack not reachable at $BASE (HTTP ${code:-none}); start it with: make up"; exit 2; }

mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete

# The offline model: a dependency-free OpenAI-compatible server (model-stub.mjs) in a throwaway
# container on the stack's own network, so the api and worker containers reach it as a local model
# server. Its address is a private IP literal on purpose: the app accepts a private endpoint only
# as an IP, localhost or host.docker.internal (never a hostname that resolves to a private address).
NETWORK="$(docker inspect dozo-api-1 --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null | awk '{print $1}')"
[ -n "$NETWORK" ] || { say "container dozo-api-1 not found; start the stack with: make up"; exit 2; }
docker rm -f "$MODEL" >/dev/null 2>&1 || true
docker run -d --name "$MODEL" --network "$NETWORK" -e PORT=8787 -v "$HERE:/stub:ro" node:24-slim node /stub/model-stub.mjs >/dev/null \
  || { say "could not start the model stub (is node:24-slim pulled? docker pull node:24-slim)"; exit 2; }
MODEL_IP="$(docker inspect "$MODEL" --format "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}")"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  docker exec dozo-api-1 node -e "fetch('http://$MODEL_IP:8787/v1/models').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break
  sleep 1
done
docker exec dozo-api-1 node -e "fetch('http://$MODEL_IP:8787/v1/models').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null \
  || { say "the api container cannot reach the model stub at $MODEL_IP:8787"; exit 2; }
say "offline model: http://$MODEL_IP:8787/v1 on network $NETWORK"

# The inventory check reads the web app's router and settings source; mount what the stack was built from.
WEBSRC="$REPO/dozo/.stage/src/apps/web/src"
[ -f "$WEBSRC/App.tsx" ] || WEBSRC="$REPO/apps/web/src"
[ -f "$WEBSRC/App.tsx" ] || { say "cannot find apps/web/src/App.tsx for the inventory check"; exit 2; }
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

say "browser: docker ($IMAGE), base $BASE, forwarder=$FORWARD"
docker run --rm --name "$NAME" --ipc=host --user "$(id -u):$(id -g)" "${NET[@]}" \
  -e HOME=/tmp -e DOZO_E2E_BASE_URL="$BASE" -e DOZO_E2E_OUT=/out \
  -e DOZO_E2E_ARGS="${DOZO_E2E_ARGS:-}" -e FORWARD="$FORWARD" -e PORT="${PORT:-80}" -e VERSION="$VERSION" \
  -e DOZO_E2E_MODEL_URL="http://$MODEL_IP:8787/v1" -e DOZO_E2E_SRC=/webapp-src \
  -v "$SUITE:/suite:ro" -v "$OUT:/out" -v "$WEBSRC:/webapp-src:ro" ${REUSE[@]+"${REUSE[@]}"} \
  "$IMAGE" bash -c '
    set -e
    mkdir /tmp/work && cd /tmp/work
    tar --warning=no-file-changed -C /suite --exclude=.out --exclude=node_modules -cf - . | tar -xf -
    npm install --no-save --no-audit --no-fund --no-package-lock --loglevel=error "@playwright/test@$VERSION" >/dev/null
    if [ "$FORWARD" = 1 ]; then
      node -e "const net=require(\"net\");net.createServer(c=>{const u=net.connect(5173,\"web\");c.pipe(u);u.pipe(c);const e=()=>{c.destroy();u.destroy()};c.on(\"error\",e);u.on(\"error\",e);c.on(\"close\",e);u.on(\"close\",e)}).listen(+process.env.PORT,\"127.0.0.1\")" &
      sleep 1
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
  '
rc=$?
if [ "$rc" -eq 0 ]; then say "PASS"; exit 0; fi
say "FAIL (docker/playwright exit $rc)"
exit 2
