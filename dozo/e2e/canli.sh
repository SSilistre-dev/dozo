#!/usr/bin/env bash
# `make canli`: the safe live smoke run against CANLI_URL (no default, so it never reaches the live
# site by accident). It opens a throwaway account, walks read-only steps limited to that account,
# deletes it in a finally step and proves it is gone. No payment, no ban, no admin action. With
# DOZO_CANLI_ADMIN_EMAIL and DOZO_CANLI_ADMIN_PASSWORD in the environment it also walks the admin
# pages read only; the two are passed to the container by name and never written anywhere.
# Output: dozo/.stage/canli/ (RAPOR.md, rapor.html, shots/, results.json). Last line:
# "CANLI: PASS|FAIL (n senaryo)". Exit 0 pass, 2 anything else.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/dozo/.stage/canli"
NAME="dozo-pw-canli-$$"
NODE_IMAGE="${DOZO_NODE_IMAGE:-node:24.22-slim}"

say() { printf 'canli: %s\n' "$*" >&2; }
verdict() { echo "CANLI: FAIL (0 senaryo)"; exit 2; }

# The machine's local-stack lock, when this machine has one (DOZO_STACK_LOCK): the run waits for it,
# because another run bringing containers and networks up or down changes the host's network
# under the test browser (net::ERR_NETWORK_CHANGED). Taken once; the re-run inside holds it.
LOCKFILE="${DOZO_STACK_LOCK:-/tmp/dozo-yigin.lock}"
if [ -z "${DOZO_CANLI_LOCKED:-}" ] && [ -e "$LOCKFILE" ] && command -v flock >/dev/null; then
  say "waiting for the local stack lock $LOCKFILE"
  DOZO_CANLI_LOCKED=1 exec flock -w 7200 "$LOCKFILE" "$0" "$@"
fi

case "${CANLI_URL:-}" in
  https://*|http://*) ;;
  *) say "CANLI_URL is not set; run: CANLI_URL=https://... make canli"; verdict ;;
esac
command -v docker >/dev/null || { say "docker not found"; verdict; }

VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$REPO/apps/web/package.json" | head -1)"
[ -n "$VERSION" ] || { say "cannot read the pinned Playwright version"; verdict; }
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

mkdir -p "$OUT"
find "$OUT" -mindepth 1 -delete
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 2' INT TERM

# The same module cache as make e2e (run.sh): the volume is opened for writing, else no cache.
CACHE=(-v "dozo-e2e-npm:/npm" -e npm_config_cache=/npm/cache)
{ docker volume inspect dozo-e2e-npm >/dev/null 2>&1 || docker volume create dozo-e2e-npm >/dev/null 2>&1; } \
  && docker run --rm -v dozo-e2e-npm:/npm "$NODE_IMAGE" chmod -R a+rwX /npm >/dev/null 2>&1 || CACHE=()

# Linux: the host's network, so a CANLI_URL on this machine (a local stack) is reachable too.
NET=(); [ "$(uname -s)" = Linux ] && NET=(--network host)
say "target $CANLI_URL, admin pages: $([ -n "${DOZO_CANLI_ADMIN_EMAIL:-}" ] && echo on || echo off)"
# -e NAME without a value: docker copies it from this environment, so no secret is on a command line.
# shellcheck disable=SC2016
docker run --init --rm --name "$NAME" --cpus "${DOZO_E2E_CPUS:-3}" --memory "${DOZO_E2E_MEMORY:-6g}" \
  --ipc=host --user "$(id -u):$(id -g)" "${NET[@]}" \
  -e HOME=/tmp -e CANLI_URL -e DOZO_CANLI_ADMIN_EMAIL -e DOZO_CANLI_ADMIN_PASSWORD \
  -e DOZO_E2E_OUT=/out -e VERSION="$VERSION" \
  -v "$HERE:/suite:ro" -v "$OUT:/out" ${CACHE[@]+"${CACHE[@]}"} \
  "$IMAGE" bash -c '
    set -e
    mkdir /tmp/work && cd /tmp/work
    tar -C /suite --exclude=.out --exclude=node_modules -cf - . | tar -xf -
    spec="@playwright/test@$VERSION"
    base=/npm/mods; [ -d /npm ] || base=/tmp/mods
    mods="$base/$(printf %s "$spec" | sha256sum | cut -c1-16)"
    if [ ! -d "$mods/node_modules/@playwright/test" ]; then
      mkdir -p "$mods.tmp"
      (cd "$mods.tmp" && npm install --prefer-offline --no-save --no-audit --no-fund --no-package-lock --loglevel=error "$spec" >/dev/null) \
        || { echo "canli: npm install of $spec failed" >&2; exit 2; }
      rm -rf "$mods"; mv "$mods.tmp" "$mods"
    fi
    ln -s "$mods/node_modules" node_modules
    set +e
    npx playwright test -c canli/playwright.config.ts
  ' &
wait $!; rc=$?
# The probe's password and session are only needed while the run lasts.
rm -f "$OUT/probe.json" "$OUT/probe-state.json"
line="$(cat "$OUT/verdict.txt" 2>/dev/null || true)"
[ -n "$line" ] || line="CANLI: FAIL (0 senaryo)"
say "report: $OUT/RAPOR.md, $OUT/rapor.html"
echo "$line"
case "$line" in "CANLI: PASS"*) [ "$rc" -eq 0 ] && exit 0 ;; esac
exit 2
