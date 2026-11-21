#!/usr/bin/env bash
# The Linux app finishes a hosted sign-in in its own window (README.md, "Hosted sign-in"), against
# the real hosted server and computer's server of dozo/e2e/hosted-login (no stand-in), on Xvfb,
# driven through WebKit's own WebDriver (tauri-driver). In Docker; nothing installed on the host.
# Usage: dozo/desktop/tests/hosted_login_window.sh <dozo-desktop binary>
#   The binary is built with DOZO_HOSTED_LOGIN_ISSUER=http://localhost:6173 (build-linux.sh), the
#   hosted server's address in that test. Screenshots go to $DOZO_WINDOW_SHOTS (default a temporary
#   folder, printed).
# Last line: HOSTED LOGIN WINDOW: PASS|FAIL. Exit 0 pass, 2 fail, 64 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP="$(cd "$HERE/.." && pwd)"
say() { echo "[window] $*"; }
verdict() { echo "HOSTED LOGIN WINDOW: $1"; [ "$1" = PASS ] && exit 0 || exit 2; }
[ $# = 1 ] && [ -x "$1" ] || { echo "usage: $0 <dozo-desktop binary>" >&2; exit 64; }
BINARY="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
SHARED="$(mktemp -d "${TMPDIR:-/tmp}/dozo-window-XXXXXX")"
SHOTS="${DOZO_WINDOW_SHOTS:-$SHARED/shots}"
mkdir -p "$SHOTS"
SERVE="dozo-hosted-e2e-window-$$"
WINDOW="dozo-hosted-window-$$"
IMAGE=dozo-desktop-window:22.04
cleanup() {
  touch "$SHARED/stop"
  docker rm -f "$WINDOW" > /dev/null 2>&1 || true
  sleep 3
  docker rm -f "$SERVE" > /dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -q -t "$IMAGE" - > /dev/null << 'DOCKERFILE' || { say "image build failed"; verdict FAIL; }
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates xvfb dbus-x11 python3 webkit2gtk-driver libwebkit2gtk-4.1-0 libayatana-appindicator3-1 \
  librsvg2-2 libxdo3 && rm -rf /var/lib/apt/lists/*
DOCKERFILE

# tauri-driver from crates.io, built once into the app's own toolchain folder (as build-linux.sh does).
DRIVER="$DESKTOP/.toolchain/linux/tauri-driver/bin/tauri-driver"
if [ ! -x "$DRIVER" ]; then
  say "building tauri-driver (once)"
  docker run --rm --cpus 3 --memory 6g -u "$(id -u):$(id -g)" -v "$DESKTOP:/desktop" -e HOME=/tmp \
    -e RUSTUP_HOME=/desktop/.toolchain/linux/rustup -e CARGO_HOME=/desktop/.toolchain/linux/cargo \
    dozo-desktop-linux:22.04 bash -c 'export PATH="$CARGO_HOME/bin:$PATH";
      cargo install tauri-driver --locked --root /desktop/.toolchain/linux/tauri-driver' \
    || { say "tauri-driver build failed (run build-linux.sh first: it makes the image and toolchain)"; verdict FAIL; }
fi

say "starting the hosted server and a computer's server"
DOZO_E2E_SHARED="$SHARED" DOZO_E2E_NAME="$SERVE" "$DESKTOP/../e2e/hosted-login/run.sh" serve \
  > "$SHARED/serve.log" 2>&1 &
for _ in $(seq 1 600); do [ -f "$SHARED/ready" ] && break; sleep 1; done
[ -f "$SHARED/ready" ] || { tail -30 "$SHARED/serve.log"; say "servers not ready"; verdict FAIL; }
say "servers: $(cat "$SHARED/ready")"

docker run --rm --name "$WINDOW" --network "container:$SERVE" --cpus 2 --memory 3g \
  -v "$BINARY:/app/dozo-desktop:ro" -v "$DRIVER:/app/tauri-driver:ro" \
  -v "$HERE/hosted_login_window.py:/app/test.py:ro" -v "$SHOTS:/shots" \
  "$IMAGE" bash -c 'xvfb-run -a -s "-screen 0 1280x900x24" dbus-run-session -- python3 /app/test.py'
rc=$?
say "screenshots: $SHOTS"
[ "$rc" = 0 ] && verdict PASS || { tail -20 "$SHARED/serve.log"; verdict FAIL; }
