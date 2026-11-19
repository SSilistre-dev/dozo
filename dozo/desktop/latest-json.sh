#!/usr/bin/env bash
# Prints the update manifest (latest.json) the desktop app reads, for one release.
# Usage: dozo/desktop/latest-json.sh <version> <download-url-base> <dir>
#   <dir> holds the release's update packages under their fixed names, each with its .sig:
#   Dozo-macOS.app.tar.gz, Dozo-Windows-x64-setup.exe, Dozo-Linux-x86_64.AppImage,
#   Dozo-Linux-amd64.deb. A missing one fails: a manifest without a platform leaves it behind.
# The updater looks up "<os>-<arch>-<install kind>" first, then "<os>-<arch>"; the universal
# macOS app serves both Mac architectures. White space around a signature is dropped: a line
# break left in a .sig file would make it fail to verify. Needs jq. Exit 0 ok, 2 failed, 64 usage.
set -euo pipefail
trap 'rc=$?; [ $rc -eq 0 ] || [ $rc -eq 64 ] || exit 2' EXIT

[ $# -eq 3 ] || { echo "usage: $0 <version> <download-url-base> <dir>" >&2; exit 64; }
version=$1 base=${2%/} dir=$3

# platform key, then file
entries=(
  darwin-aarch64 Dozo-macOS.app.tar.gz
  darwin-x86_64 Dozo-macOS.app.tar.gz
  windows-x86_64 Dozo-Windows-x64-setup.exe
  linux-x86_64 Dozo-Linux-x86_64.AppImage
  linux-x86_64-appimage Dozo-Linux-x86_64.AppImage
  linux-x86_64-deb Dozo-Linux-amd64.deb
)

platforms='{}'
for ((i = 0; i < ${#entries[@]}; i += 2)); do
  key=${entries[i]} file=${entries[i + 1]}
  [ -s "$dir/$file" ] && [ -s "$dir/$file.sig" ] || { echo "missing $file or its .sig in $dir" >&2; exit 2; }
  platforms=$(jq -c --arg key "$key" --arg url "$base/$file" --rawfile sig "$dir/$file.sig" \
    '.[$key] = {url: $url, signature: ($sig | gsub("\\s"; ""))}' <<<"$platforms")
done

jq -n --arg version "$version" --argjson platforms "$platforms" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{version: $version, pub_date: $date, platforms: $platforms}'
