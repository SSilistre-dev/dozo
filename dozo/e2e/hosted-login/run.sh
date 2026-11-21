#!/usr/bin/env bash
# Hosted login end to end (README.md): a hosted server and computers' servers, all real server
# bundles with Postgres, and a real browser, in one Docker container on this machine. Touches no
# live service.
# Usage: dozo/e2e/hosted-login/run.sh [serve]
#   DOZO_E2E_MANIFEST  the server manifest to test (a URL, or a path to a manifest.json whose
#                      files sit beside it); default the release named below
#   serve              start the hosted server and one computer's server and keep them up for the
#                      desktop window test (dozo/desktop/tests/hosted_login_window.sh), which joins
#                      this container's network (DOZO_E2E_NAME names the container); writes
#                      $DOZO_E2E_SHARED/ready once up and stops when $DOZO_E2E_SHARED/stop appears
# Last line: HOSTED LOGIN E2E: PASS|FAIL. Exit 0 pass, 2 fail, 64 usage.
# Container: --cpus 3 --memory 6g, named dozo-hosted-e2e-<pid>; cache volume dozo-hosted-e2e-cache
# (downloads and the Playwright package, keyed by checksum and version).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
RELEASE_MANIFEST="https://github.com/SSilistre-dev/dozo/releases/download/server-v0.11.0-5/manifest.json"
say() { echo "[hosted-e2e] $*"; }
verdict() { echo "HOSTED LOGIN E2E: $1"; [ "$1" = PASS ] && exit 0 || exit 2; }

if [ "${1:-}" = --inside ]; then
  set -e
  apt-get update -qq > /dev/null
  apt-get install -y -qq --no-install-recommends libfaketime xz-utils > /dev/null
  mods="/cache/npm-$PW_VERSION"
  [ -d "$mods/node_modules/playwright" ] || npm i -s --prefix "$mods" "playwright@$PW_VERSION" > /dev/null
  node /repo/dozo/e2e/hosted-login/e2e.mjs prepare
  chown -R pwuser /work
  exec runuser -u pwuser -- env PLAYWRIGHT_MODULES="$mods/node_modules" \
    node /repo/dozo/e2e/hosted-login/e2e.mjs "${MODE:-run}"
fi

case "${1:-run}" in run | serve) ;; *) echo "usage: $0 [serve]" >&2; exit 64 ;; esac
command -v docker > /dev/null || { say "docker not found"; verdict FAIL; }
VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$REPO/apps/web/package.json" | head -1)"
[ -n "$VERSION" ] || { say "no @playwright/test version in apps/web/package.json"; verdict FAIL; }
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"
MANIFEST="${DOZO_E2E_MANIFEST:-$RELEASE_MANIFEST}"
mounts=()
case "$MANIFEST" in
  http://* | https://*) ;;
  *) [ -f "$MANIFEST" ] || { say "no manifest at $MANIFEST"; verdict FAIL; }
     mounts=(-v "$(cd "$(dirname "$MANIFEST")" && pwd):/dist:ro"); MANIFEST="/dist/$(basename "$MANIFEST")" ;;
esac
SHARED="${DOZO_E2E_SHARED:-}"
[ -z "$SHARED" ] || mounts+=(-v "$SHARED:/shared")
name="${DOZO_E2E_NAME:-dozo-hosted-e2e-$$}"
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT INT TERM
say "manifest $MANIFEST, image $IMAGE"
docker run --rm --name "$name" --cpus 3 --memory 6g --init --ipc=host \
  -v "$REPO:/repo:ro" -v dozo-hosted-e2e-cache:/cache "${mounts[@]}" \
  -e MANIFEST="$MANIFEST" -e PW_VERSION="$VERSION" -e MODE="${1:-run}" \
  "$IMAGE" bash /repo/dozo/e2e/hosted-login/run.sh --inside
rc=$?
[ "$rc" = 0 ] && verdict PASS || verdict FAIL
