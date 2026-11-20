#!/usr/bin/env bash
# End-to-end test of the server on this computer (src/stack.rs), without a window: the app's own
# code installs a real server bundle from a local manifest, starts it, gets 200 from /health and
# stops it, and in between pairs this computer with it and connects the device socket ("Let Bots
# Use This Computer"); then starts it again from what is installed and is killed with SIGKILL;
# then starts it once more and pairs a phone through the bundled relay agent: a dev relay and a
# phone run in a second container on the same loopback (tests/relay_phone.mts, with the workspace
# from the dozo-qa-deps volume, read only, and this checkout's relay files over it). After each,
# no process of the server may be left. Then the same as on macOS, where nothing ends the
# processes with the app: they stay after the SIGKILL, and the next start ends them. Last, a server of its own signs in with the hosted account
# against a stand-in hosted server (tests/fake_issuer.mjs, in the same second container).
# With an older bundle as well, a fifth step updates a server installed from it to <dist-dir>'s,
# keeping its account, then tries a newer, broken version and checks the server comes back as it
# was (src/stack_update.rs).
# Usage: dozo/desktop/tests/stack_e2e.sh <dist-dir> [<older-dist-dir>]
#   <dist-dir> holds dozo-server-linux-x64.tar.xz and its .json (dozo/server-bundle/build.sh).
#   node-linux-x64.tar.xz and postgres-linux-x64.tar.gz in it, when there, are used instead of
#   downloading them (their sha256 must still be the one in runtimes.json).
# Runs in the desktop build image (build-linux.sh) as the calling user, --cpus 3 --memory 6g.
# Last line: DESKTOP STACK E2E: PASS|FAIL. Exit 0 pass, 2 fail, 64 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verdict() { echo "DESKTOP STACK E2E: $1"; [ "$1" = PASS ] && exit 0 || exit 2; }
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: $0 <dist-dir> [<older-dist-dir>]" >&2; exit 64; }
DIST="$(cd "$1" && pwd)" || exit 64
OLD="$DIST"
[ $# -lt 2 ] || OLD="$(cd "$2" && pwd)" || exit 64
[ -f "$DIST/dozo-server-linux-x64.tar.xz" ] || { echo "no bundle in $DIST" >&2; verdict FAIL; }
NAME="dozo-desktop-stack-e2e-$$"
trap 'docker rm -f "$NAME" "$NAME-manifest" "$NAME-phone" > /dev/null 2>&1 || true' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM

# The manifest, made by the script a release uses, then pointed at the local runtimes if present.
# For the update step: the older bundle's manifest, and a newer version whose Node is broken (it
# exits 1), so its migration fails.
docker run --rm --name "$NAME-manifest" --cpus 3 --memory 6g --user "$(id -u):$(id -g)" \
  -v "$HERE/../server-bundle:/bundle:ro" -v "$DIST:/dist" -v "$OLD:/dist-old" "${DOZO_NODE_IMAGE:-node:24.22-slim}" \
  bash -c 'set -e; node /bundle/manifest.mjs /dist file:///dist; node /bundle/manifest.mjs /dist-old file:///dist-old
    mkdir -p /tmp/broken/node-broken/bin && printf "#!/bin/sh\nexit 1\n" > /tmp/broken/node-broken/bin/node
    chmod +x /tmp/broken/node-broken/bin/node && tar -C /tmp/broken -czf /dist/node-broken.tar.gz node-broken
    node -e "
    const fs = require(\"node:fs\");
    const crypto = require(\"node:crypto\");
    const local = (dir, out, version) => {
      const m = JSON.parse(fs.readFileSync(dir + \"/manifest.json\", \"utf8\"));
      const p = m.platforms[\"linux-x64\"];
      for (const [part, file] of [[\"node\", \"node-linux-x64.tar.xz\"], [\"postgres\", \"postgres-linux-x64.tar.gz\"]])
        if (fs.existsSync(\"/dist/\" + file)) p[part].url = \"file:///dist/\" + file;
      if (version) {
        const bytes = fs.readFileSync(\"/dist/node-broken.tar.gz\");
        m.version = version;
        p.node = { version: \"broken\", url: \"file:///dist/node-broken.tar.gz\", size: bytes.length,
          sha256: crypto.createHash(\"sha256\").update(bytes).digest(\"hex\") };
      }
      fs.writeFileSync(out, JSON.stringify(m, null, 2));
    };
    local(\"/dist\", \"/dist/e2e-manifest.json\");
    local(\"/dist-old\", \"/dist/e2e-old-manifest.json\");
    local(\"/dist\", \"/dist/e2e-broken-manifest.json\", \"99.0.0\");
  "' || verdict FAIL

# initdb looks the user up and refuses root, as on a desktop: an ordinary user with a name.
[ "$(id -u)" != 0 ] || { echo "run it as an ordinary user" >&2; verdict FAIL; }
mkdir -p "$HERE/target"
printf 'root:x:0:0::/root:/bin/sh\ndozo:x:%s:%s::/tmp:/bin/sh\n' "$(id -u)" "$(id -g)" > "$HERE/target/e2e-passwd"
# The relay and the phone; the app's container joins this one's network, so both see 127.0.0.1.
ROOT="$(cd "$HERE/../.." && pwd)"
SHARED="$HERE/target/e2e-shared"
rm -rf "$SHARED" && mkdir -p "$SHARED" && chmod 777 "$SHARED"
overlay=()
for file in "$ROOT"/packages/{core,contracts,adapters}/src/dozo-relay*.ts; do
  case "$file" in *.test.ts) continue ;; esac
  overlay+=(-v "$file:/d/w/${file#"$ROOT"/}:ro")
done
docker run -d --name "$NAME-phone" --cpus 1 --memory 1g -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e DOZO_WORKSPACE=/d/w -v dozo-qa-deps:/d:ro "${overlay[@]}" -v "$HERE/tests:/tests:ro" \
  -v "$SHARED:/shared" "${DOZO_NODE_IMAGE:-node:24.22-slim}" \
  sh -c 'node /tests/fake_issuer.mjs 8788 & exec /d/w/node_modules/.bin/tsx /tests/relay_phone.mts /shared' \
  > /dev/null || verdict FAIL
docker run --rm -i --name "$NAME" --network "container:$NAME-phone" --cpus 3 --memory 6g -e CARGO_BUILD_JOBS=3 -u "$(id -u):$(id -g)" \
  -v "$HERE/..:/dozo" -v "$DIST:/dist:ro" -v "$OLD:/dist-old:ro" -e DOZO_STACK_E2E_UPDATE="$([ "$OLD" != "$DIST" ] && echo 1 || echo 0)" -v "$HERE/target/e2e-passwd:/etc/passwd:ro" -w /dozo/desktop -e HOME=/tmp \
  -e RUSTUP_HOME=/dozo/desktop/.toolchain/linux/rustup \
  -e CARGO_HOME=/dozo/desktop/.toolchain/linux/cargo \
  -e DOZO_STACK_E2E_MANIFEST=file:///dist/e2e-manifest.json -e DOZO_STACK_E2E_ROOT=/tmp/e2e/server \
  -e DOZO_STACK_E2E_RELAY=http://127.0.0.1:8787 -e DOZO_STACK_E2E_SHARED=/shared -v "$SHARED:/shared" \
  dozo-desktop-linux:22.04 bash -s <<'EOF'
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
say "2b. as on macOS (no PDEATHSIG): SIGKILL the app, then the next start ends what it left"
"$BIN" --ignored --exact stack::tests::e2e_hold_as_on_macos_until_killed --nocapture > /tmp/e2e/hold2.log 2>&1 &
app=$!
for _ in $(seq 240); do grep -q 'E2E: holding' /tmp/e2e/hold2.log && break; kill -0 $app 2>/dev/null || break; sleep 0.5; done
grep -q 'E2E: holding' /tmp/e2e/hold2.log || { say "FAILED: the start did not get ready"; tail -5 /tmp/e2e/hold2.log; exit 2; }
kill -KILL $app; wait $app 2>/dev/null; sleep 2
say "left running after SIGKILL, as on macOS: $(left | wc -l) processes"
"$BIN" --ignored --exact stack::tests::e2e_ends_what_a_crashed_app_left --nocapture \
  2>&1 | grep -E 'E2E: [^SDPR]|panicked|test result|assert' || { say "FAILED: see the lines above"; tail -n 15 "$DOZO_STACK_E2E_ROOT"/logs/manager.log; exit 2; }
[ -z "$(left)" ] || { say "FAILED: left after stop: $(left)"; exit 2; }
say "3. start again and pair a phone through the relay agent"
"$BIN" --ignored --exact stack::tests::e2e_pairs_a_phone --nocapture \
  2>&1 | grep -E 'E2E: [^SDP]|panicked|test result|assert' || { say "FAILED: see the lines above"; tail -n 15 "$DOZO_STACK_E2E_ROOT"/logs/{manager,relay,relay-command}.log; exit 2; }
[ -z "$(left)" ] || { say "FAILED: left after stop: $(left)"; exit 2; }
say "4. a server of its own signs in with the hosted account (stand-in issuer)"
# A server that has accounts of its own refuses that mode: a new folder, the same install.
mkdir -p /tmp/e2e/hosted && cp -a "$DOZO_STACK_E2E_ROOT"/{versions,current} /tmp/e2e/hosted/
DOZO_STACK_E2E_ROOT=/tmp/e2e/hosted DOZO_STACK_E2E_ISSUER=http://127.0.0.1:8788 \
  "$BIN" --ignored --exact stack::tests::e2e_signs_in_with_the_hosted_account --nocapture \
  2>&1 | grep -E 'E2E: [^SDP]|panicked|test result|assert' || { say "FAILED: see the lines above"; tail -n 15 /tmp/e2e/hosted/logs/{manager,api}.log; exit 2; }
DOZO_STACK_E2E_ROOT=/tmp/e2e/hosted; [ -z "$(left)" ] || { say "FAILED: left after stop: $(left)"; exit 2; }
if [ "$DOZO_STACK_E2E_UPDATE" = 1 ]; then
  say "5. update a server installed from the older bundle, then try a broken newer one"
  DOZO_STACK_E2E_ROOT=/tmp/e2e/update DOZO_STACK_E2E_OLD_MANIFEST=file:///dist/e2e-old-manifest.json \
    DOZO_STACK_E2E_BROKEN_MANIFEST=file:///dist/e2e-broken-manifest.json \
    "$BIN" --ignored --exact stack::tests::e2e_updates_and_goes_back --nocapture \
    2>&1 | grep -E 'E2E: [^SDPR]|panicked|test result|assert' || { say "FAILED: see the lines above"; tail -n 25 /tmp/e2e/update/logs/manager.log; exit 2; }
  DOZO_STACK_E2E_ROOT=/tmp/e2e/update; [ -z "$(left)" ] || { say "FAILED: left after stop: $(left)"; exit 2; }
fi
EOF
rc=$?
docker logs "$NAME-phone" 2>&1 | tail -5
[ $rc = 0 ] || verdict FAIL
verdict PASS
