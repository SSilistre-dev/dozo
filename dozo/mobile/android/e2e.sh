#!/usr/bin/env bash
# Runs inside the booted emulator's job (.github/workflows/dozo-mobile-android.yml): installs the
# APK, keeps the device log, and runs the pairing test (pair-e2e.mts) against the branded tree.
# Usage: dozo/mobile/android/e2e.sh <apk> <branded-tree> <out-dir>
# Needs adb and maestro on PATH and DATABASE_URL. Exit 0 pass, 2 fail, 64 usage.
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <apk> <branded-tree> <out-dir>" >&2; exit 64; }
APK="$1" TREE="$(cd "$2" && pwd)" OUT="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"

adb install -r "$APK" || exit 2
adb logcat -c
adb logcat > "$OUT/logcat.txt" 2>&1 &
logcat=$!
trap 'kill $logcat 2> /dev/null' EXIT

DOZO_WORKSPACE="$TREE" timeout --signal=INT --kill-after=30s 20m \
  node "$TREE/node_modules/tsx/dist/cli.mjs" "$HERE/pair-e2e.mts" "$OUT" 2>&1 | tee "$OUT/run.log"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || exit 2
