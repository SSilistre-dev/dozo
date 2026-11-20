#!/usr/bin/env bash
# End-to-end test of the server on this computer (src/stack.rs), without a window: the app's own
# code installs a real server bundle from a local manifest, starts it, gets 200 from /health and
# stops it, and in between pairs this computer with it and connects the device socket ("Let Bots
# Use This Computer"); then starts it again from what is installed and is killed with SIGKILL.
# After both, no process of the server may be left.
# Usage: dozo/desktop/tests/stack_e2e.sh <dist-dir>
#   <dist-dir> holds dozo-server-linux-x64.tar.xz and its .json (dozo/server-bundle/build.sh).
#   node-linux-x64.tar.xz and postgres-linux-x64.tar.gz in it, when there, are used instead of
#   downloading them (their sha256 must still be the one in runtimes.json).
# Runs in the desktop build image (build-linux.sh) as the calling user, --cpus 3 --memory 6g.
# Last line: DESKTOP STACK E2E: PASS|FAIL. Exit 0 pass, 2 fail, 64 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verdict() { echo "DESKTOP STACK E2E: $1"; [ "$1" = PASS ] && exit 0 || exit 2; }
[ $# -eq 1 ] || { echo "usage: $0 <dist-dir>" >&2; exit 64; }
DIST="$(cd "$1" && pwd)" || exit 64
[ -f "$DIST/dozo-server-linux-x64.tar.xz" ] || { echo "no bundle in $DIST" >&2; verdict FAIL; }
NAME="dozo-desktop-stack-e2e-$$"
trap 'docker rm -f "$NAME" "$NAME-manifest" > /dev/null 2>&1 || true' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

# The manifest, made by the script a release uses, then pointed at the local runtimes if present.
docker run --rm --name "$NAME-manifest" --cpus 3 --memory 6g --user "$(id -u):$(id -g)" \
  -v "$HERE/../server-bundle:/bundle:ro" -v "$DIST:/dist" "${DOZO_NODE_IMAGE:-node:24.22-slim}" \
  bash -c 'node /bundle/manifest.mjs /dist file:///dist && node -e "
    const fs = require(\"node:fs\");
    const m = JSON.parse(fs.readFileSync(\"/dist/manifest.json\", \"utf8\"));
    const p = m.platforms[\"linux-x64\"];
    for (const [part, file] of [[\"node\", \"node-linux-x64.tar.xz\"], [\"postgres\", \"postgres-linux-x64.tar.gz\"]])
      if (fs.existsSync(\"/dist/\" + file)) p[part].url = \"file:///dist/\" + file;
    fs.writeFileSync(\"/dist/e2e-manifest.json\", JSON.stringify(m, null, 2));
  "' || verdict FAIL

# initdb looks the user up and refuses root, as on a desktop: an ordinary user with a name.
[ "$(id -u)" != 0 ] || { echo "run it as an ordinary user" >&2; verdict FAIL; }
mkdir -p "$HERE/target"
printf 'root:x:0:0::/root:/bin/sh\ndozo:x:%s:%s::/tmp:/bin/sh\n' "$(id -u)" "$(id -g)" > "$HERE/target/e2e-passwd"
docker run --rm -i --name "$NAME" --cpus 3 --memory 6g -e CARGO_BUILD_JOBS=3 -u "$(id -u):$(id -g)" \
  -v "$HERE/..:/dozo" -v "$DIST:/dist:ro" -v "$HERE/target/e2e-passwd:/etc/passwd:ro" -w /dozo/desktop -e HOME=/tmp \
  -e RUSTUP_HOME=/dozo/desktop/.toolchain/linux/rustup \
  -e CARGO_HOME=/dozo/desktop/.toolchain/linux/cargo \
  -e DOZO_STACK_E2E_MANIFEST=file:///dist/e2e-manifest.json -e DOZO_STACK_E2E_ROOT=/tmp/e2e/server \
  dozo-desktop-linux:22.04 bash -s <<'EOF' || verdict FAIL
set -uo pipefail
export PATH="$CARGO_HOME/bin:$PATH"
say() { echo "[e2e] $*"; }
# Processes whose program or command line is in the server's folder (no ps in the image).
left() {
  local p
  for p in /proc/[0-9]*; do
    if readlink "$p/exe" 2>/dev/null | grep -q "^$DOZO_STACK_E2E_ROOT" \
      || { tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null | grep -q "$DOZO_STACK_E2E_ROOT"; then
      echo "${p#/proc/}: $({ tr '\0' ' ' < "$p/cmdline"; } 2>/dev/null)"
    fi
  done
}
BIN=$(cargo test --locked --no-run 2>&1 | sed -n 's/.*Executable unittests src\/main.rs (\(.*\))/\1/p')
[ -x "$BIN" ] || { say "FAILED: no test binary"; exit 2; }
rm -rf /tmp/e2e
say "1. install, start, /health, stop"
"$BIN" --ignored --exact stack::tests::e2e_installs_starts_and_stops_the_real_server --nocapture \
  2>&1 | grep -E 'E2E|panicked|test result' || { say "FAILED: see the lines above"; tail -n 15 "$DOZO_STACK_E2E_ROOT"/logs/*.log; exit 2; }
[ -z "$(left)" ] || { say "FAILED: left after stop: $(left)"; exit 2; }
say "2. start again from what is installed, then SIGKILL the app"
"$BIN" --ignored --exact stack::tests::e2e_hold_until_killed --nocapture > /tmp/e2e/hold.log 2>&1 &
app=$!
for _ in $(seq 1 240); do grep -q 'E2E: holding' /tmp/e2e/hold.log && break; kill -0 $app 2>/dev/null || break; sleep 0.5; done
grep -E 'E2E' /tmp/e2e/hold.log
grep -q 'E2E: holding' /tmp/e2e/hold.log || { say "FAILED: the second start did not get ready"; exit 2; }
grep -q 'Downloading' /tmp/e2e/hold.log && { say "FAILED: the second start downloaded again"; exit 2; }
[ -n "$(left)" ] || { say "FAILED: nothing running before the kill"; exit 2; }
kill -KILL $app; wait $app 2>/dev/null
for _ in $(seq 1 60); do [ -z "$(left)" ] && break; sleep 0.5; done
[ -z "$(left)" ] || { say "FAILED: left after SIGKILL of the app: $(left)"; exit 2; }
say "no process left after SIGKILL of the app"
say "data folder: $(cd "$DOZO_STACK_E2E_ROOT" && ls | tr '\n' ' ')"
say "versions: $(ls "$DOZO_STACK_E2E_ROOT/versions" | tr '\n' ' ')"
say "secrets: $(stat -c %a "$DOZO_STACK_E2E_ROOT/secrets"), downloads left: $(ls "$DOZO_STACK_E2E_ROOT/downloads" | wc -l)"
EOF
verdict PASS
