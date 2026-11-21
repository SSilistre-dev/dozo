#!/usr/bin/env bash
# End-to-end test of the server on this computer (src/stack.rs, src/stack_e2e.rs), without a window
# and without Docker, on Linux or macOS: the app's own code installs a real server bundle from a
# manifest, starts it, gets 200 from /health, signs up, pairs this computer and connects the
# device socket, and stops it (1); starts it again from what is installed and the app is killed
# with SIGKILL: on Linux nothing of the server outlives it, on macOS what is left is ended by the
# next start (2); a phone pairs through the bundled relay agent, the codes match on both ends, the
# computer allows it, the phone signs in, is listed and removed (3); a second install signs in
# with the hosted account against a stand-in (4). With DOZO_STACK_E2E_OLD_MANIFEST (an older
# server, e.g. a release's manifest.json) a fifth step installs that one with an account, updates
# it to <dist-dir>'s and the account still signs in, then a newer version whose Node is broken is
# put back and the server runs as it was (src/stack_update.rs); a sixth backs that server up and
# restores it over newer data (src/stack_backup.rs). After each, no process of the server is left.
# The data folder is under a home whose path holds a space and non-ASCII letters. Step 0 first
# drives the bot's own browser (src/browser_e2e.rs) with the Chrome installed on the runner.
#
# Usage:
#   stack_e2e_native.sh <dist-dir> <workspace>      steps 1-4 against a dev relay (hermetic)
#   stack_e2e_native.sh --relay <url> <workspace>   the canary: steps 1 and 3 against a real
#                                                  relay, with the released server; every channel
#                                                  this run made is revoked at the end
#   <dist-dir>   holds dozo-server-<platform>.tar.xz and its .json (dozo/server-bundle/build.mjs);
#                the manifest is made there unless DOZO_STACK_E2E_MANIFEST names one.
#   <workspace>  a branded tree with its packages installed: the relay, the phone and the stand-in
#                issuer run from it (tests/relay_phone.mts, tests/fake_issuer.mjs). "-" when they
#                already run beside this on 127.0.0.1 and share DOZO_STACK_E2E_SHARED
#                (tests/stack_e2e.sh, in Docker).
# Needs Rust (rust-toolchain.toml), and Node 24 unless both the manifest and the phone come from
# elsewhere. DOZO_STACK_E2E_WORK: where its folders go (default RUNNER_TEMP, else TMPDIR); the
# logs, the servers' own included, end up in its logs folder. In GitHub Actions it puts that folder
# and the server's in DOZO_STACK_E2E_LOGS and DOZO_STACK_E2E_SERVER for the steps after it.
# Last line: DESKTOP STACK E2E (<os>): PASS|FAIL, or RELAY CANARY: PASS|FAIL. Exit 0 pass,
# 2 fail, 64 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS="macos-$(uname -m | sed 's/x86_64/x64/')" ;;
  *) echo "Linux or macOS only (Windows: tests/stack_e2e_windows.ps1)" >&2; exit 64 ;;
esac
RELAY=""
if [ "${1:-}" = --relay ]; then RELAY="${2:-}"; shift 2 || exit 64; fi
if [ -z "$RELAY" ] && [ $# -eq 2 ]; then
  DIST="$1" WORKSPACE="$2"
elif [ "${RELAY#https://}" != "$RELAY" ] && [ $# -eq 1 ]; then
  DIST="" WORKSPACE="$1"
else
  echo "usage: $0 <dist-dir> <workspace> | --relay <https url> <workspace>" >&2
  exit 64
fi
# Absolute, as the steps below run from this directory.
absolute() { [ "$1" = - ] && echo - || (cd "$1" && pwd); }
WORKSPACE="$(absolute "$WORKSPACE")" || exit 64
[ -z "$DIST" ] || DIST="$(absolute "$DIST")" || exit 64
LABEL="DESKTOP STACK E2E ($OS)"
[ -z "$RELAY" ] || LABEL="RELAY CANARY"
say() { echo "[e2e] $*"; }
fail() { say "FAILED: $*"; exit 2; }

BASE="${DOZO_STACK_E2E_WORK:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
BASE="${BASE%/}/Dozo e2e ğüş"
E2E_HOME="$BASE/home of a user"
ROOT="$E2E_HOME/server data"
HOSTED="$E2E_HOME/hosted server"
UPDATED="$E2E_HOME/updated server"
LOGS="$BASE/logs"
export DOZO_STACK_E2E_SHARED="${DOZO_STACK_E2E_SHARED:-$BASE/shared}"
export DOZO_STACK_E2E_RELAY="${RELAY:-${DOZO_STACK_E2E_RELAY:-http://127.0.0.1:8787}}"
rm -rf "$BASE" && mkdir -p "$ROOT" "$LOGS" "$DOZO_STACK_E2E_SHARED" || exit 2
# For the workflow's later steps: where the logs are, and the server's folder (relay_revoke.sh).
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'DOZO_STACK_E2E_LOGS=%s\nDOZO_STACK_E2E_SERVER=%s\n' "$LOGS" "$ROOT" >> "$GITHUB_ENV"
fi
helpers=()
finish() {
  local rc=$?
  for pid in ${helpers[@]+"${helpers[@]}"}; do kill "$pid" 2> /dev/null; done
  [ $rc = 0 ] || [ ! -f "$LOGS/phone.log" ] || { echo "----- phone"; tail -n 10 "$LOGS/phone.log"; }
  cp -R "$ROOT/logs" "$LOGS/server" 2> /dev/null
  cp -R "$HOSTED/logs" "$LOGS/hosted server" 2> /dev/null
  cp -R "$UPDATED/logs" "$LOGS/updated server" 2> /dev/null
  if [ -n "$RELAY" ]; then bash "$HERE/tests/relay_revoke.sh" "$ROOT" || rc=2; fi
  local status=PASS
  [ $rc = 0 ] || status=FAIL
  [ $rc = 0 ] || [ $rc = 2 ] || rc=2
  echo "$LABEL: $status"
  exit $rc
}
trap finish EXIT
trap 'exit 2' INT TERM

clock=$SECONDS
took() { say "$1 took $((SECONDS - clock)) s"; clock=$SECONDS; }

if [ -n "$RELAY" ]; then
  say "the released server, the relay at $RELAY"
elif [ -z "${DOZO_STACK_E2E_MANIFEST:-}" ]; then
  # Node and Postgres from where they are published, and the manifest, by the scripts a release
  # uses; all three parts are then read from <dist-dir>, as a release serves them.
  platform=$(cd "$DIST" && ls dozo-server-*.json | sed -n 's/^dozo-server-\(.*\)\.json$/\1/p' | head -n 1)
  [ -n "$platform" ] || fail "no bundle in $DIST"
  node "$HERE/../server-bundle/runtimes.mjs" "$DIST" "$platform" || fail "runtimes.mjs"
  node "$HERE/../server-bundle/manifest.mjs" "$DIST" "file://$DIST" || fail "manifest.mjs"
  export DOZO_STACK_E2E_MANIFEST="file://$DIST/manifest.json"
  # For step 5: the same server as a newer version whose Node exits 1, so it cannot start.
  # In <dist-dir>, whose path is plain, so the file addresses need no escaping.
  mkdir -p "$BASE/broken/node-broken/bin" && printf '#!/bin/sh\nexit 1\n' > "$BASE/broken/node-broken/bin/node"
  chmod +x "$BASE/broken/node-broken/bin/node"
  tar -C "$BASE/broken" -czf "$DIST/node-broken.tar.gz" node-broken || exit 2
  node -e '
    const fs = require("node:fs");
    const dist = process.argv[1];
    const m = JSON.parse(fs.readFileSync(`${dist}/manifest.json`, "utf8"));
    const bytes = fs.readFileSync(`${dist}/node-broken.tar.gz`);
    const sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    m.version = "99.0.0";
    for (const p of Object.values(m.platforms))
      p.node = { version: "broken", url: `file://${dist}/node-broken.tar.gz`, size: bytes.length, sha256 };
    fs.writeFileSync(`${dist}/broken-manifest.json`, JSON.stringify(m, null, 2));
  ' "$DIST" || fail "the broken manifest"
  export DOZO_STACK_E2E_BROKEN_MANIFEST="file://$DIST/broken-manifest.json"
fi

cd "$HERE" || exit 2
BIN=$(cargo test --locked --no-run 2>&1 | tee "$LOGS/build.log" \
  | sed -n 's/.*Executable unittests src\/main.rs (\(.*\))/\1/p')
[ -n "$BIN" ] && [ -x "$HERE/$BIN" ] || { tail -n 30 "$LOGS/build.log"; fail "no test binary"; }
BIN="$HERE/$BIN"
took "the test build"

# One ignored test of src/stack_e2e.rs, with the home above and the server's folder in $2. Its
# full output goes to $LOGS/<name>.log; the lines it says are shown.
run_test() {
  local name=$1 folder=$2 rc
  DOZO_STACK_E2E_ROOT="$folder" HOME="$E2E_HOME" \
    "$BIN" --ignored --exact "stack::e2e::$name" --nocapture > "$LOGS/$name.log" 2>&1
  rc=$?
  grep -E 'E2E: [a-z]|panicked|assert|still running|test result' "$LOGS/$name.log"
  if [ $rc != 0 ]; then
    for log in "$folder"/logs/*.log; do [ -f "$log" ] && { echo "----- ${log##*/}"; tail -n 15 "$log"; }; done
    fail "$name"
  fi
}
# What of the server in $1 is running: the same check the tests make, on every system.
left() {
  DOZO_STACK_E2E_ROOT="$1" "$BIN" --ignored --exact stack::e2e::e2e_list_left --nocapture 2> /dev/null \
    | sed -n 's/^LEFT: //p'
}
none_left() {
  local folder=$1 when=$2 still
  for _ in $(seq 60); do
    still=$(left "$folder")
    [ -z "$still" ] && { say "no process left $when"; return 0; }
    sleep 0.5
  done
  fail "left $when: $still"
}
# Starts a test that holds the server until killed; returns once it is ready. $app is the test
# binary itself, so a SIGKILL ends the app and nothing else.
hold() {
  DOZO_STACK_E2E_ROOT="$ROOT" HOME="$E2E_HOME" \
    "$BIN" --ignored --exact "stack::e2e::$1" --nocapture > "$LOGS/$1.log" 2>&1 &
  app=$!
  for _ in $(seq 480); do
    grep -q 'E2E: holding' "$LOGS/$1.log" 2> /dev/null && break
    kill -0 $app 2> /dev/null || break
    sleep 0.5
  done
  grep -E 'E2E: ready' "$LOGS/$1.log"
  grep -q 'E2E: holding' "$LOGS/$1.log" || { tail -n 20 "$LOGS/$1.log"; fail "$1 did not get ready"; }
  ! grep -q 'Downloading' "$LOGS/$1.log" || fail "$1 downloaded again"
  [ -n "$(left "$ROOT")" ] || fail "nothing of the server running in $1"
}
kill_app() {
  kill -KILL $app
  wait $app 2> /dev/null
  say "the app was killed with SIGKILL"
}

if [ -z "$RELAY" ]; then
  # The bot's own browser (src/browser.rs, src/browser_e2e.rs): the installed Chrome with a profile
  # of its own, driven through the pipe only (no TCP port), what is not allowed refused, and the
  # browser ends with a killed app. On Linux in a real window under Xvfb, with a screenshot of the
  # page and, when ImageMagick is there, of the whole screen (the window and its address bar).
  say "0. the bot's own browser"
  browser_test() {
    "$BIN" --ignored --exact "browser::e2e::$1" --nocapture > "$LOGS/$1.log" 2>&1
    local rc=$?
    grep -E 'E2E: [a-zA-Z]|panicked|assert|test result' "$LOGS/$1.log"
    [ $rc = 0 ] || fail "$1"
  }
  export DOZO_BROWSER_E2E_SHOT="$LOGS/browser-page.png"
  if [ "$OS" = linux ] && command -v Xvfb > /dev/null; then
    Xvfb :87 -screen 0 1280x800x24 > /dev/null 2>&1 &
    helpers+=($!)
    export DISPLAY=:87 DOZO_BROWSER_E2E_WINDOW=1
    sleep 1
  fi
  browser_test e2e_browser_page_tools_work_through_the_pipe_only
  browser_test e2e_browser_guard_holds_in_windows_and_frames
  export DOZO_BROWSER_E2E_ROOT="$BASE/browser"
  "$BIN" --ignored --exact browser::e2e::e2e_browser_hold_until_killed --nocapture \
    > "$LOGS/e2e_browser_hold_until_killed.log" 2>&1 &
  app=$!
  for _ in $(seq 120); do
    grep -q 'E2E: holding' "$LOGS/e2e_browser_hold_until_killed.log" 2> /dev/null && break
    kill -0 $app 2> /dev/null || break
    sleep 0.5
  done
  browser=$(sed -n 's/^E2E: browser pid //p' "$LOGS/e2e_browser_hold_until_killed.log")
  [ -n "$browser" ] || { tail -n 20 "$LOGS/e2e_browser_hold_until_killed.log"; fail "the browser did not start"; }
  if [ -n "${DOZO_BROWSER_E2E_WINDOW:-}" ] && command -v import > /dev/null; then
    sleep 2
    import -window root "$LOGS/browser-window.png" && say "the browser's window captured"
  fi
  kill_app
  for _ in $(seq 40); do kill -0 "$browser" 2> /dev/null || break; sleep 0.25; done
  if kill -0 "$browser" 2> /dev/null; then
    [ "$OS" = linux ] && fail "the browser outlived the killed app (PR_SET_PDEATHSIG)"
    say "the browser outlived the killed app; the next start ends it"
  else
    say "the browser ended with the killed app"
  fi
  browser_test e2e_browser_ends_what_a_crashed_app_left
  unset DOZO_BROWSER_E2E_ROOT DOZO_BROWSER_E2E_SHOT DOZO_BROWSER_E2E_WINDOW
  took "step 0"
fi

say "1. install, start, /health, sign up, this computer connects, stop"
run_test e2e_installs_starts_and_stops_the_real_server "$ROOT"
none_left "$ROOT" "after stop"
took "step 1"

if [ -z "$RELAY" ]; then
  say "2. start again from what is installed, then SIGKILL the app"
  if [ "$OS" = linux ]; then
    hold e2e_hold_until_killed
    kill_app
    none_left "$ROOT" "after SIGKILL of the app (PR_SET_PDEATHSIG)"
    say "2b. as on macOS, without PR_SET_PDEATHSIG"
    hold e2e_hold_as_on_macos_until_killed
  else
    hold e2e_hold_until_killed
  fi
  kill_app
  sleep 2
  say "left running after the SIGKILL: $(left "$ROOT" | wc -l | tr -d ' ') processes; the next start ends them"
  run_test e2e_ends_what_a_crashed_app_left "$ROOT"
  none_left "$ROOT" "after stop"
  say "secrets folder mode: $(stat -c %a "$ROOT/secrets" 2> /dev/null || stat -f %Lp "$ROOT/secrets")"
  took "step 2"
fi

say "3. start again and pair a phone through the relay agent ($DOZO_STACK_E2E_RELAY)"
if [ "$WORKSPACE" != - ]; then
  phone_args=("$HERE/tests/relay_phone.mts" "$DOZO_STACK_E2E_SHARED")
  [ -z "$RELAY" ] || phone_args+=(--no-dev-relay)
  DOZO_WORKSPACE="$WORKSPACE" node "$WORKSPACE/node_modules/tsx/dist/cli.mjs" "${phone_args[@]}" \
    > "$LOGS/phone.log" 2>&1 &
  helpers+=($!)
  if [ -z "$RELAY" ]; then
    node "$HERE/tests/fake_issuer.mjs" 8788 > "$LOGS/issuer.log" 2>&1 &
    helpers+=($!)
  fi
fi
run_test e2e_pairs_a_phone "$ROOT"
if [ -n "$RELAY" ]; then
  say "what the relay agent logged, by event: $(sed -n 's/.*"event":"\([a-z-]*\)".*/\1/p' \
    "$ROOT/logs/relay.log" | sort | uniq -c | tr -s ' \n' ' ')"
fi
none_left "$ROOT" "after stop, relay agent included"
took "step 3"

if [ -z "$RELAY" ]; then
  say "4. a server of its own signs in with the hosted account (stand-in issuer)"
  # A server that has accounts of its own refuses that mode: a new folder, the same install.
  mkdir -p "$HOSTED" && cp -a "$ROOT/versions" "$ROOT/current" "$HOSTED/" || exit 2
  DOZO_STACK_E2E_ISSUER=http://127.0.0.1:8788 run_test e2e_signs_in_with_the_hosted_account "$HOSTED"
  none_left "$HOSTED" "after stop"
  took "step 4"
fi
if [ -z "$RELAY" ] && [ -n "${DOZO_STACK_E2E_OLD_MANIFEST:-}" ]; then
  say "5. update a server installed from $DOZO_STACK_E2E_OLD_MANIFEST, then try a broken newer one"
  mkdir -p "$UPDATED" || exit 2
  run_test e2e_updates_and_goes_back "$UPDATED"
  none_left "$UPDATED" "after stop"
  took "step 5"
  say "6. back up that server, then restore it over newer data"
  run_test e2e_backs_up_and_restores "$UPDATED"
  none_left "$UPDATED" "after stop"
  took "step 6"
fi
say "all steps passed in $SECONDS s"
