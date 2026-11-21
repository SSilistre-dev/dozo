#!/usr/bin/env bash
# End-to-end test of the server on this computer (src/stack.rs), without a window, in Docker: the
# steps are tests/stack_e2e_native.sh (which CI runs on Linux and macOS without Docker). The app's own
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
# was (src/stack_update.rs); and a sixth backs that server up and restores it over newer data
# with the bundle's own command (src/stack_backup.rs).
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
  bash -c 'set -e
    # manifest.mjs wants the pinned runtimes beside the bundle under their own names.
    for d in /dist /dist-old; do for part in node:node-linux-x64.tar.xz postgres:postgres-linux-x64.tar.gz; do
      name=$(node -p "require(\"/bundle/runtimes.json\").${part%%:*}.platforms[\"linux-x64\"].url.split(\"/\").pop()")
      [ -e "$d/$name" ] || { [ -e "$d/${part#*:}" ] && cp "$d/${part#*:}" "$d/$name"; } || [ -e "/dist/${part#*:}" ] && cp "/dist/${part#*:}" "$d/$name" || true
    done; done
    node /bundle/manifest.mjs /dist file:///dist; node /bundle/manifest.mjs /dist-old file:///dist-old
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
# The steps themselves are tests/stack_e2e_native.sh, as CI runs them without Docker.
docker run --rm --name "$NAME" --network "container:$NAME-phone" --cpus 3 --memory 6g -e CARGO_BUILD_JOBS=3 -u "$(id -u):$(id -g)" \
  -v "$HERE/..:/dozo" -v "$DIST:/dist:ro" -v "$HERE/target/e2e-passwd:/etc/passwd:ro" -w /dozo/desktop -e HOME=/tmp \
  -e RUSTUP_HOME=/dozo/desktop/.toolchain/linux/rustup \
  -e CARGO_HOME=/dozo/desktop/.toolchain/linux/cargo \
  -v "$OLD:/dist-old:ro" -e DOZO_STACK_E2E_MANIFEST=file:///dist/e2e-manifest.json -e DOZO_STACK_E2E_WORK=/tmp \
  -e DOZO_STACK_E2E_OLD_MANIFEST="$([ "$OLD" != "$DIST" ] && echo file:///dist/e2e-old-manifest.json)" \
  -e DOZO_STACK_E2E_BROKEN_MANIFEST=file:///dist/e2e-broken-manifest.json \
  -e TZ=Europe/Istanbul -e DOZO_STACK_E2E_SHARED=/shared -v "$SHARED:/shared" \
  dozo-desktop-linux:22.04 bash -c 'PATH="$CARGO_HOME/bin:$PATH" exec bash tests/stack_e2e_native.sh /dist -'
rc=$?
docker logs "$NAME-phone" 2>&1 | tail -5
[ $rc = 0 ] || verdict FAIL
verdict PASS
