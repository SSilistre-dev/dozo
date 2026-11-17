#!/bin/sh
# Regenerates every PNG/ICO from the SVG masters on the host: host node (render.mjs, built-ins only)
# driving headless Brave, plus host python3 (standard library). Nothing is installed; no Docker.
# This is the owner-accepted exception to the Docker-only rule in dozo/AGENTS.md.
# Usage: dozo/brand/assets/build.sh   (set E2E_BROWSER_PATH for another Chromium-based browser)
set -eu
cd "$(dirname "$0")"
# .tmp holds the small PNGs between the render and the ICO steps; gone on success, failure and interrupt alike.
trap 'rm -rf .tmp' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 make-og.py
python3 make-app-art.py
node render.mjs raster.json
python3 make-ico.py web/favicon.ico web/favicon-16x16.png web/favicon-32x32.png .tmp/favicon-48.png
python3 make-ico.py desktop/icon.ico .tmp/icon-16.png .tmp/icon-32.png .tmp/icon-48.png .tmp/icon-64.png .tmp/icon-128.png .tmp/icon-256.png
# Opaque by design: the iOS legacy icon, the widget mark, the DMG background and the mail hero.
python3 make-rgb.py desktop/background.png desktop/background@2x.png mobile/icon.png mobile/icon-background.png mobile/app-mark.png mail/welcome.png
