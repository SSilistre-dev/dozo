#!/usr/bin/env bash
# Runs the Dozo e2e suite in the official Playwright image against the running stack.
# Exit 0 pass, 2 on any failure (stack unreachable, a failed test, zero tests run).
# Output and run-time files are deleted at the end unless DOZO_E2E_KEEP=1.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SUITE="${DOZO_E2E_SUITE:-$HERE}"
OUT="$HERE/.out"
BASE="${DOZO_E2E_BASE_URL:-http://127.0.0.1:5173}"
NAME="dozo-pw-e2e"

say() { printf 'e2e: %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
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

# The app only accepts the origin it was configured with (127.0.0.1:<port>), so the browser must
# reach the stack under that same name. Linux: --network host. Docker Desktop (macOS): the container
# has no route to the host's loopback, so a 5-line forwarder inside the container listens on
# 127.0.0.1:<port> and relays to host.docker.internal; the browser still sees 127.0.0.1:<port>.
PORT="$(printf '%s' "$BASE" | sed -n 's#^https\{0,1\}://[^:/]*:\([0-9]*\).*#\1#p')"
NET=(--add-host host.docker.internal:host-gateway)
FORWARD=1
if [ "$(uname -s)" = Linux ]; then NET=(--network host); FORWARD=0; fi

say "browser: docker ($IMAGE), base $BASE, forwarder=$FORWARD"
docker run --rm --name "$NAME" --ipc=host --user "$(id -u):$(id -g)" "${NET[@]}" \
  -e HOME=/tmp -e DOZO_E2E_BASE_URL="$BASE" -e DOZO_E2E_OUT=/out \
  -e DOZO_E2E_ARGS="${DOZO_E2E_ARGS:-}" -e FORWARD="$FORWARD" -e PORT="${PORT:-80}" -e VERSION="$VERSION" \
  -v "$SUITE:/suite:ro" -v "$OUT:/out" \
  "$IMAGE" bash -c '
    set -e
    mkdir /tmp/work && cd /tmp/work
    tar --warning=no-file-changed -C /suite --exclude=.out --exclude=node_modules -cf - . | tar -xf -
    npm install --no-save --no-audit --no-fund --no-package-lock --loglevel=error "@playwright/test@$VERSION" >/dev/null
    if [ "$FORWARD" = 1 ]; then
      node -e "require(\"net\").createServer(c=>{const u=require(\"net\").connect(+process.env.PORT,\"host.docker.internal\");c.pipe(u).pipe(c);const e=()=>{c.destroy();u.destroy()};c.on(\"error\",e);u.on(\"error\",e)}).listen(+process.env.PORT,\"127.0.0.1\")" &
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
