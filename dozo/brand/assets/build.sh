#!/bin/sh
# Rasterise all PNG/ICO assets in a throwaway Docker container (Debian + librsvg + ImageMagick + Inter).
# Usage: dozo/brand/assets/build.sh   (run from anywhere; needs Docker)
set -eu
D="$(cd "$(dirname "$0")" && pwd)"
docker run --rm -v "$D":/a -w /a python:3.12-slim sh -ec '
apt-get update -qq >/dev/null
apt-get install -y -qq fonts-inter librsvg2-bin imagemagick >/dev/null 2>&1
pip install -q fonttools 2>/dev/null; python make-og.py
r() { rsvg-convert -w "$2" -h "$3" "$1" -o "$4"; convert "$4" PNG32:"$4"; }
mkdir -p /tmp/ico; TMPDIR_ICO=/tmp/ico
cd web
r ../app-icon-fullbleed.svg 192 192 icon-192.png
r ../app-icon-fullbleed.svg 512 512 icon-512.png
r ../app-icon-fullbleed.svg 180 180 apple-touch-icon.png
r ../favicon.svg 128 128 favicon.png
r ../favicon.svg 32 32 favicon-32x32.png
r ../favicon.svg 16 16 favicon-16x16.png
r ../favicon.svg 48 48 $TMPDIR_ICO/f48.png
python ../make-ico.py favicon.ico favicon-16x16.png favicon-32x32.png $TMPDIR_ICO/f48.png
cd ..
rsvg-convert -w 1200 -h 630 og-image.svg -o og-image.png; convert og-image.png PNG24:og-image.png
'
