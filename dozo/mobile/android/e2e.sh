#!/usr/bin/env bash
# Runs inside the booted emulator's job (.github/workflows/dozo-mobile-android.yml): waits until the
# system has finished starting, installs the APK, keeps the device log, and runs the pairing test
# (pair-e2e.mts) against the branded tree. On a failure it keeps what was on screen: the window
# list (a system dialog over the app is named there) and any "not responding" report in the log.
# Usage: dozo/mobile/android/e2e.sh <apk> <branded-tree> <out-dir>
# Needs adb and maestro on PATH and DATABASE_URL. Exit 0 pass, 2 fail, 64 usage.
set -uo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <apk> <branded-tree> <out-dir>" >&2; exit 64; }
APK="$1" TREE="$(cd "$2" && pwd)" OUT="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"
say() { echo "[e2e] $*"; }
prop() { adb shell getprop "$1" 2> /dev/null | tr -d '\r'; }

# The emulator runner returns once the device answers; the system is still starting then (boot
# broadcasts, the launcher, background jobs), and a test that starts meanwhile races that work.
# Ready means: boot completed, the boot animation stopped, the package manager answers, and every
# broadcast queue is idle (the boot broadcasts were delivered).
ready() {
  local t=$SECONDS
  until [ "$(prop sys.boot_completed)" = 1 ] && [ "$(prop init.svc.bootanim)" = stopped ] \
    && adb shell pm path android > /dev/null 2>&1; do
    [ $((SECONDS - t)) -lt 300 ] || { say "the system did not finish starting in 300 s"; return 1; }
    sleep 1
  done
  timeout 300 adb shell am wait-for-broadcast-idle > /dev/null \
    || { say "the broadcast queues did not go idle in 300 s"; return 1; }
  say "system ready after $((SECONDS - t)) s"
}

# What covered the app when a step failed: the focused window and any dialog of the system's.
diagnose() {
  adb shell dumpsys window windows > "$OUT/windows.txt" 2>&1
  adb shell dumpsys activity activities > "$OUT/activities.txt" 2>&1
  say "focused window: $(grep -m 1 -oE 'mCurrentFocus=[^ ]+ [^ ]+ [^}]+' "$OUT/windows.txt")"
  grep -oE 'Application (Not Responding|Error): [A-Za-z0-9._]+' "$OUT/windows.txt" | sort -u | sed 's/^/[e2e] system dialog: /'
  grep -E 'ActivityManager: ANR in|Input dispatching timed out' "$OUT/logcat.txt" | sed 's/^/[e2e] /' | head -n 5
}

ready || { diagnose; exit 2; }
adb install -r "$APK" || exit 2
adb logcat -c
adb logcat > "$OUT/logcat.txt" 2>&1 &
logcat=$!
trap 'kill $logcat 2> /dev/null' EXIT

DOZO_WORKSPACE="$TREE" timeout --signal=INT --kill-after=30s 20m \
  node "$TREE/node_modules/tsx/dist/cli.mjs" "$HERE/pair-e2e.mts" "$OUT" 2>&1 | tee "$OUT/run.log"
rc=${PIPESTATUS[0]}
# How long the app took to show its first screen, each time it started.
grep -oE 'Displayed dev\.ssilistre\.dozo/[^ ]+ for user 0: \+[0-9a-z]+' "$OUT/logcat.txt" | sed 's/^/[e2e] /'
[ "$rc" -eq 0 ] && exit 0
diagnose
exit 2
