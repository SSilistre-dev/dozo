#!/usr/bin/env bash
# Runs only the `inventory` project of the e2e suite: every route, settings section and overlay of
# the branded web app is crawled or skipped with a reason. No browser, no stack, a few seconds, so
# the gate runs it on every pull request and a moved or renamed file is caught at once.
# Needs the staged tree (make stage). Exit 0 pass, 2 on any failure.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STAGE="${DOZO_STAGE_DIR:-$REPO/dozo/.stage}"
case "$STAGE" in /*) ;; *) STAGE="$PWD/${STAGE#./}" ;; esac
WEBSRC="$STAGE/src/apps/web/src"
[ -f "$STAGE/stage.complete" ] && [ -f "$WEBSRC/App.tsx" ] \
  || { echo "inventory: no complete staged tree at $STAGE/src; run: make stage" >&2; exit 2; }

VERSION="$(sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' "$REPO/apps/web/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "inventory: cannot read the pinned Playwright version" >&2; exit 2; }

NAME="dozo-e2e-inventory-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM
docker run --init --rm --name "$NAME" --cpus 1 --memory 2g --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e VERSION="$VERSION" -e DOZO_E2E_SRC=/webapp-src -e DOZO_E2E_OUT=/tmp/out \
  -v "$HERE:/suite:ro" -v "$WEBSRC:/webapp-src:ro" \
  "mcr.microsoft.com/playwright:v${VERSION}-noble" bash -c '
    set -e
    mkdir /tmp/work && cd /tmp/work
    tar --warning=no-file-changed -C /suite --exclude=.out --exclude=node_modules -cf - . | tar -xf -
    npm install --no-save --no-audit --no-fund --no-package-lock --loglevel=error "@playwright/test@$VERSION" >/dev/null
    npx playwright test --project=inventory
  ' || { echo "inventory: FAIL" >&2; exit 2; }
echo "inventory: PASS"
