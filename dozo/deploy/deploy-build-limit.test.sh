#!/usr/bin/env bash
# Offline checks of the build limit (deploy-build-limit.sh): `remote` runs the host's script in the
# local shell with stub systemctl, docker and id on PATH and a temporary folder for the cgroup tree;
# no ssh is started and nothing on this machine is touched. Run by `gate.sh olc`.
# Usage: deploy-build-limit.test.sh. Exit 0 all pass, 1 a case failed (each is printed).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/deploy-build-limit.sh"
DEPLOY="${DEPLOY_SH:-$HERE/deploy.sh}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dozo-buildlimit-test.XXXXXX")
FAILED=0
bad() { FAILED=1; echo "[buildlimit.test] FAIL: $*"; }
trap 'rm -rf "$WORK"' EXIT
CG="$WORK/cg"
BIN="$WORK/bin"
SLICE=dozobuild.slice
mkdir -p "$BIN"

# systemctl: FAKE_SYSCTL ok | startfail | setfail | wrong (the limits do not land on the cgroup).
cat >"$BIN/systemctl" <<STUB
#!/bin/sh
echo "\$*" >>"$WORK/sys.calls"
d="$CG/$SLICE"
case \$1 in
  start)
    [ "\${FAKE_SYSCTL:-ok}" != startfail ] || exit 1
    mkdir -p "\$d"
    printf 'max\n' >"\$d/memory.high"; printf 'max\n' >"\$d/memory.max"; printf 'max\n' >"\$d/memory.swap.max"
    printf '100\n' >"\$d/cpu.weight"; printf 'default 100\n' >"\$d/io.weight"
    printf 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n' >"\$d/memory.events" ;;
  set-property)
    [ "\${FAKE_SYSCTL:-ok}" != setfail ] || exit 1
    [ "\${FAKE_SYSCTL:-ok}" != wrong ] || exit 0
    shift 2
    for kv in "\$@"; do
      v=\${kv#*=}
      case \${kv%%=*} in
        MemoryHigh) case \$v in *G) v=\$((\${v%G} * 1073741824)) ;; *M) v=\$((\${v%M} * 1048576)) ;; esac; echo "\$v" >"\$d/memory.high" ;;
        MemoryMax) case \$v in *G) v=\$((\${v%G} * 1073741824)) ;; *M) v=\$((\${v%M} * 1048576)) ;; esac; echo "\$v" >"\$d/memory.max" ;;
        MemorySwapMax) echo "\$v" >"\$d/memory.swap.max" ;;
        CPUWeight) echo "\$v" >"\$d/cpu.weight" ;;
        IOWeight) printf 'default %s\n8:0 %s\n' "\$v" "\$v" >"\$d/io.weight" ;;
      esac
    done ;;
esac
exit 0
STUB
# docker: image inspect fails unless FAKE_HAVE; builds are logged one per line; FAKE_FAIL_AT=<n> makes
# the nth build fail, and with FAKE_OOM it first counts an out-of-memory kill in the slice.
cat >"$BIN/docker" <<STUB
#!/bin/sh
case \$1 in
  image)
    case \$2 in
      inspect) [ -n "\${FAKE_HAVE:-}" ]; exit \$? ;;
      rm) echo "rm \$*" >>"$WORK/docker.calls"; exit 0 ;;
    esac ;;
  build)
    case " \$* " in *" -f - "*) cat >/dev/null ;; esac
    echo "\$*" >>"$WORK/docker.calls"
    n=\$(grep -c '^build' "$WORK/docker.calls")
    if [ "\${FAKE_FAIL_AT:-0}" = "\$n" ]; then
      [ -z "\${FAKE_OOM:-}" ] || printf 'low 0\nhigh 0\nmax 1\noom 1\noom_kill 1\n' >"$CG/$SLICE/memory.events"
      echo "build step failed" >&2; exit 1
    fi ;;
esac
exit 0
STUB
cat >"$BIN/id" <<STUB
#!/bin/sh
echo "\${FAKE_UID:-0}"
STUB
chmod +x "$BIN"/*
# The git, ssh, rsync, curl and jq deploy.sh checks for; ssh only records that it was started.
for t in git rsync curl jq; do printf '#!/bin/sh\nexit 0\n' >"$BIN/$t"; done
printf '#!/bin/sh\necho x >>"%s/ssh.calls"\nexit 255\n' "$WORK" >"$BIN/ssh"
chmod +x "$BIN"/*

# The "deploy" process: the library with the options, helpers and ERR trap deploy.sh runs with, and a
# `remote` of the same shape (the host's shell run locally). Settings come in through the environment.
cat >"$WORK/driver.sh" <<DRV
set -Eeuo pipefail
. "$LIB"
say() { printf '[deploy] %s\n' "\$*"; }
die() { printf '[deploy] FAIL: %s\n' "\$*" >&2; exit 2; }
trap 'die "line \$LINENO: \$BASH_COMMAND"' ERR
remote() { "\$@"; }
remote_dir="$WORK/dir"
build_limit_validate
build_images "\$remote_dir" abc123
DRV

# fresh: an empty cgroup root that is a v2 one (it has cgroup.controllers) and an empty systemd dir.
fresh() {
  rm -rf "$CG" "$WORK/dir" "$WORK/sys.calls" "$WORK/docker.calls" "$WORK/ssh.calls" "$WORK/sysd"
  mkdir -p "$CG" "$WORK/sysd" "$WORK/dir/src" "$WORK/dir/theme"
  echo "cpuset cpu io memory pids" >"$CG/cgroup.controllers"
}
# run [VAR=value ...]: the driver on the stubs; output in $out, status in $rc.
run() {
  out=$(env -u DOZO_DEPLOY_BUILD_LIMIT -u DOZO_DEPLOY_BUILD_MEMORY_HIGH -u DOZO_DEPLOY_BUILD_MEMORY_MAX \
    -u DOZO_DEPLOY_BUILD_CPU_WEIGHT -u DOZO_DEPLOY_BUILD_IO_WEIGHT \
    PATH="$BIN:$PATH" DOZO_CGROUP_ROOT="$CG" DOZO_SYSTEMD_DIR="$WORK/sysd" "$@" bash "$WORK/driver.sh" 2>&1)
  rc=$?
}
builds() { grep -c '^build' "$WORK/docker.calls" 2>/dev/null || true; }
flagged() { grep -c -- '^build.*--cgroup-parent='"$SLICE" "$WORK/docker.calls" 2>/dev/null || true; }
lines() { printf '%s\n' "$out" | grep -c 'NOT limited'; }
# A case that ends with the builds running unlimited, one line saying so, and no ERR trap line.
unlimited_case() {
  [ "$rc" = 0 ] || bad "$1: want exit 0, got $rc ($out)"
  [ "$(lines)" = 1 ] || bad "$1: want exactly one NOT limited line: $out"
  [ "$(builds)" = 4 ] || bad "$1: builds ran $(builds) times, want 4"
  [ "$(flagged)" = 0 ] || bad "$1: a build carried the cgroup flag"
  case $out in *"FAIL: line"*) bad "$1: the ERR trap fired: $out" ;; esac
}
# No name of this machine or its user in anything printed.
noself() {
  case $out in
    *"$(id -un)"*) bad "$1: the output names the user" ;;
    *"$(hostname)"*) bad "$1: the output names the host" ;;
  esac
}

# Limits applied (defaults) and read back; the four builds carry the flag; the setup is systemctl only.
fresh
run
[ "$rc" = 0 ] || bad "defaults: want exit 0, got $rc ($out)"
case $out in
  *"build limited in $SLICE (memory.high 4294967296, memory.max 6442450944, swap.max 0, cpu.weight 20, io.weight 20)"*) ;;
  *) bad "defaults: no limited line with the read-back values: $out" ;;
esac
[ "$(builds)" = 4 ] && [ "$(flagged)" = 4 ] || bad "defaults: want 4 builds all with --cgroup-parent=$SLICE, got $(builds) and $(flagged)"
grep -qx "start $SLICE" "$WORK/sys.calls" || bad "defaults: the slice was not started"
grep -qx "set-property --runtime $SLICE MemoryHigh=4G MemoryMax=6G MemorySwapMax=0 CPUWeight=20 IOWeight=20" "$WORK/sys.calls" ||
  bad "defaults: wrong set-property call: $(cat "$WORK/sys.calls")"
grep -q 'rm image rm dozo/app:abc123-base' "$WORK/docker.calls" || bad "defaults: the base image was not removed"
case $out in *"FAIL: line"*) bad "defaults: the ERR trap fired: $out" ;; esac
noself defaults

# Settings change the values and the read-back follows.
fresh
run DOZO_DEPLOY_BUILD_MEMORY_HIGH=512M DOZO_DEPLOY_BUILD_MEMORY_MAX=1G DOZO_DEPLOY_BUILD_CPU_WEIGHT=50 DOZO_DEPLOY_BUILD_IO_WEIGHT=30
case $out in
  *"memory.high 536870912, memory.max 1073741824, swap.max 0, cpu.weight 50, io.weight 30)"*) ;;
  *) bad "settings: the limited line does not hold the settings: $out" ;;
esac
[ "$(flagged)" = 4 ] || bad "settings: want 4 flagged builds, got $(flagged)"

# The read-back differs from what was asked: not limited, builds as before.
fresh
run FAKE_SYSCTL=wrong
unlimited_case readback-mismatch
case $out in *"did not land"*) ;; *) bad "readback-mismatch: reason missing: $out" ;; esac
noself readback-mismatch

# No systemd, cgroup v1, not root, a slice that will not start, limits systemd refuses.
fresh; rmdir "$WORK/sysd"; run; unlimited_case no-systemd
case $out in *"systemd"*) ;; *) bad "no-systemd: reason missing: $out" ;; esac
[ ! -e "$WORK/sys.calls" ] || bad "no-systemd: systemctl was called"
fresh; rm "$CG/cgroup.controllers"; run; unlimited_case cgroup-v1
case $out in *"cgroup v2"*) ;; *) bad "cgroup-v1: reason missing: $out" ;; esac
[ ! -e "$WORK/sys.calls" ] || bad "cgroup-v1: systemctl was called"
fresh; run FAKE_UID=1000; unlimited_case not-root
case $out in *"not root"*) ;; *) bad "not-root: reason missing: $out" ;; esac
[ ! -e "$WORK/sys.calls" ] || bad "not-root: systemctl was called"
fresh; run FAKE_SYSCTL=startfail; unlimited_case start-fails
fresh; run FAKE_SYSCTL=setfail; unlimited_case set-fails

# Turned off: no slice, no systemctl, no flag, one line.
fresh
run DOZO_DEPLOY_BUILD_LIMIT=off
unlimited_case off
[ ! -e "$WORK/sys.calls" ] || bad "off: systemctl was called"
[ ! -e "$CG/$SLICE" ] || bad "off: a slice exists"

# Images already on the host: nothing is built, no slice is made, only the one old line is printed.
fresh
run FAKE_HAVE=1
[ "$rc" = 0 ] || bad "images present: want exit 0, got $rc ($out)"
[ "$out" = "[deploy] host: the images of abc123 are there, nothing to build" ] || bad "images present: output changed: $out"
[ ! -e "$WORK/sys.calls" ] && [ ! -e "$WORK/docker.calls" ] || bad "images present: systemctl or a build ran"

# A build step killed for memory fails the deploy and names the setting; the run stops at that step.
fresh
run FAKE_FAIL_AT=3 FAKE_OOM=1
[ "$rc" = 2 ] || bad "oom: want exit 2, got $rc ($out)"
case $out in *"raise DOZO_DEPLOY_BUILD_MEMORY_MAX"*) ;; *) bad "oom: the message does not name the setting: $out" ;; esac
case $out in *"the image build failed"*) ;; *) bad "oom: no failure line: $out" ;; esac
[ "$(builds)" = 3 ] || bad "oom: the builds went on after the failed step ($(builds))"
case $out in *"FAIL: line"*) bad "oom: the ERR trap fired: $out" ;; esac
# A failure that is not memory does not blame the setting.
fresh
run FAKE_FAIL_AT=2
[ "$rc" = 2 ] || bad "plain failure: want exit 2, got $rc"
case $out in *DOZO_DEPLOY_BUILD_MEMORY_MAX*) bad "plain failure: blamed the memory setting: $out" ;; esac

# deploy.sh itself: a bad setting is refused with exit 64 before any ssh; it builds only through
# build_images (no bare docker build left in it).
cat >"$WORK/deploy.conf" <<CONF
DOZO_DEPLOY_SSH=host
DOZO_DEPLOY_DOMAIN=dozo.example
DOKPLOY_URL=https://panel.example
DOKPLOY_COMPOSE_ID=x
DOKPLOY_API_KEY=k
CONF
for kv in DOZO_DEPLOY_BUILD_LIMIT=maybe DOZO_DEPLOY_BUILD_MEMORY_HIGH=lots DOZO_DEPLOY_BUILD_MEMORY_HIGH=4GB \
  DOZO_DEPLOY_BUILD_MEMORY_MAX=0 'DOZO_DEPLOY_BUILD_MEMORY_MAX=6G;x' DOZO_DEPLOY_BUILD_CPU_WEIGHT=0 \
  DOZO_DEPLOY_BUILD_CPU_WEIGHT=10001 DOZO_DEPLOY_BUILD_IO_WEIGHT=abc DOZO_DEPLOY_BUILD_IO_WEIGHT=-5; do
  fresh
  out=$(env PATH="$BIN:$PATH" DOZO_DEPLOY_CONF="$WORK/deploy.conf" "$kv" bash "$DEPLOY" 2>&1)
  rc=$?
  [ "$rc" = 64 ] || bad "$kv: want exit 64 from deploy.sh, got $rc ($out)"
  [ ! -e "$WORK/ssh.calls" ] || bad "$kv: ssh was started before the setting was refused"
  case $out in *"${kv%%=*}"*) ;; *) bad "$kv: the message does not name the setting: $out" ;; esac
done
if grep -q 'docker build' "$DEPLOY"; then bad "deploy.sh still runs docker build itself"; fi
# Building on the host (DOZO_DEPLOY_BUILD=host) goes through build_images, inside that branch.
grep -A2 '^if \[ "\$ship_mode" = host \]; then$' "$DEPLOY" | grep -q '^  build_images "\$remote_dir" "\$tag"$' ||
  bad "deploy.sh does not build on the host through build_images"

exit "$FAILED"
