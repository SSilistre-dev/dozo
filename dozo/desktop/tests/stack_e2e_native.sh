#!/usr/bin/env bash
# End-to-end test of the server on this computer (src/stack.rs, src/stack_e2e.rs), without a window
# and without Docker, on Linux or macOS: the app's own code installs a real server bundle from a
# manifest, starts it, gets 200 from /health, signs up, pairs this computer and connects the
# device socket, and stops it (1); starts it again from what is installed and the app is killed
# with SIGKILL: on Linux nothing of the server outlives it, on macOS what is left is ended by the
# next start (2); a phone pairs through the bundled relay agent, the codes match on both ends, the
# computer allows it, the phone signs in, is listed and removed (3); a second install signs in
# with the hosted account against a stand-in (4). After each, no process of the server is left.
# The data folder is under a home whose path holds a space and non-ASCII letters.
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
LABEL="DESKTOP STACK E2E ($OS)"
[ -z "$RELAY" ] || LABEL="RELAY CANARY"
say() { echo "[e2e] $*"; }
fail() { say "FAILED: $*"; exit 2; }

BASE="${DOZO_STACK_E2E_WORK:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
BASE="${BASE%/}/Dozo e2e ğüş"
E2E_HOME="$BASE/home of a user"
ROOT="$E2E_HOME/server data"
HOSTED="$E2E_HOME/hosted server"
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
  DIST="$(cd "$DIST" && pwd)" || exit 64
  node "$HERE/../server-bundle/manifest.mjs" "$DIST" "file://$DIST" || fail "manifest.mjs"
  export DOZO_STACK_E2E_MANIFEST="file://$DIST/manifest.json"
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
  WORKSPACE="$(cd "$WORKSPACE" && pwd)" || exit 64
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
say "all steps passed in $SECONDS s"
