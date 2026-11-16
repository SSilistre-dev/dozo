#!/bin/sh
# Regenerates every PNG/ICO from the SVG masters on the host: headless Brave (render.mjs, Node
# built-ins only) + the Python 3 standard library. Nothing is installed; no Docker.
# Usage: dozo/brand/assets/build.sh   (set E2E_BROWSER_PATH for another Chromium-based browser)
set -eu
cd "$(dirname "$0")"
# .tmp holds the 48 px favicon between the two steps; gone on success, failure and interrupt alike.
trap 'rm -rf .tmp' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 make-og.py
node render.mjs raster.json
python3 make-ico.py web/favicon.ico web/favicon-16x16.png web/favicon-32x32.png .tmp/favicon-48.png
