#!/usr/bin/env bash
# The image build on the host, kept out of the way of the running app: its containers go into a
# systemd slice with a memory ceiling, no swap, and a low CPU and IO weight. Sourced by deploy.sh;
# needs say, die, `remote` and $remote_dir. Tested offline with `remote` pointed at the local shell
# and stub systemctl, docker and id: dozo/deploy/deploy-build-limit.test.sh. Settings, the two
# lines it prints and the limits of the method: dozo/deploy/README.md, Build limit.
#
# Mechanism: `systemctl start` creates the slice, `systemctl set-property --runtime` sets the
# limits on the live unit (systemd enables the controllers in the parent for it, which writing the
# cgroup files by hand would have to do too, and it owns the group, so nothing else resets them),
# and the limits are READ BACK from the slice's cgroup files: the limit counts only when the
# files hold what was asked. The name has no dash: a dash means nesting to systemd ("dozo-build"
# is "dozo/build") while Docker makes the directory at the top, so the two would disagree.

build_limit_mode=on build_limit_high=4G build_limit_max=6G build_limit_cpu=20 build_limit_io=20

build_limit_refuse() {
  printf '[deploy] FAIL: %s must be %s, got "%s"\n' "$1" "$2" "$3" >&2
  exit 64
}

# Reads the settings and refuses a bad one (exit 64) before anything touches the host.
build_limit_validate() {
  local size='^[1-9][0-9]{0,5}[KMG]?$' weight='^[1-9][0-9]{0,4}$'
  build_limit_mode=${DOZO_DEPLOY_BUILD_LIMIT:-on}
  build_limit_high=${DOZO_DEPLOY_BUILD_MEMORY_HIGH:-4G}
  build_limit_max=${DOZO_DEPLOY_BUILD_MEMORY_MAX:-6G}
  build_limit_cpu=${DOZO_DEPLOY_BUILD_CPU_WEIGHT:-20}
  build_limit_io=${DOZO_DEPLOY_BUILD_IO_WEIGHT:-20}
  case $build_limit_mode in on | off) ;; *) build_limit_refuse DOZO_DEPLOY_BUILD_LIMIT "on or off" "$build_limit_mode" ;; esac
  [[ $build_limit_high =~ $size ]] ||
    build_limit_refuse DOZO_DEPLOY_BUILD_MEMORY_HIGH "a size like 4G, 512M or 800K" "$build_limit_high"
  [[ $build_limit_max =~ $size ]] ||
    build_limit_refuse DOZO_DEPLOY_BUILD_MEMORY_MAX "a size like 6G, 512M or 800K" "$build_limit_max"
  [[ $build_limit_cpu =~ $weight && $build_limit_cpu -le 10000 ]] ||
    build_limit_refuse DOZO_DEPLOY_BUILD_CPU_WEIGHT "a whole number from 1 to 10000" "$build_limit_cpu"
  [[ $build_limit_io =~ $weight && $build_limit_io -le 10000 ]] ||
    build_limit_refuse DOZO_DEPLOY_BUILD_IO_WEIGHT "a whole number from 1 to 10000" "$build_limit_io"
}

# The host side. $1 dir, $2 tag, $3 on|off, $4 memory high, $5 memory max, $6 cpu weight, $7 io
# weight. Setting the limits never fails the run: any problem prints one "NOT limited" line and the
# build goes on as before. DOZO_CGROUP_ROOT and DOZO_SYSTEMD_DIR exist for the offline test only.
build_host_script() {
  cat <<'HOST'
set -euo pipefail
dir=$1 tag=$2 mode=$3 high=$4 max=$5 cpu=$6 io=$7
slice=dozobuild.slice
cgroot=${DOZO_CGROUP_ROOT:-/sys/fs/cgroup}
sysd=${DOZO_SYSTEMD_DIR:-/run/systemd/system}
cgflag=""

bytes() {
  local n=${1%[KMG]}
  case $1 in
    *K) echo $((n * 1024)) ;;
    *M) echo $((n * 1048576)) ;;
    *G) echo $((n * 1073741824)) ;;
    *) echo "$n" ;;
  esac
}
unlimited() { echo "[deploy] host: build NOT limited: $1"; cgflag=""; }
rd() { sed -n 1p "$cgroot/$slice/$1" 2>/dev/null || true; }

limit_setup() {
  local want got iov
  if [ "$mode" = off ]; then unlimited "turned off (DOZO_DEPLOY_BUILD_LIMIT=off)"; return 0; fi
  if [ "$(id -u 2>/dev/null)" != 0 ]; then unlimited "the deploy user is not root"; return 0; fi
  if [ ! -d "$sysd" ] || ! command -v systemctl >/dev/null 2>&1; then
    unlimited "the host does not run systemd"; return 0
  fi
  if [ ! -r "$cgroot/cgroup.controllers" ]; then unlimited "the host does not use cgroup v2"; return 0; fi
  if ! systemctl start "$slice" >/dev/null 2>&1; then unlimited "systemd could not start $slice"; return 0; fi
  if ! systemctl set-property --runtime "$slice" MemoryHigh="$high" MemoryMax="$max" MemorySwapMax=0 \
    CPUWeight="$cpu" IOWeight="$io" >/dev/null 2>&1; then
    unlimited "systemd refused the limits on $slice"; return 0
  fi
  want="$(bytes "$high") $(bytes "$max") 0 $cpu $io"
  iov=$(rd io.weight); iov=${iov#default }
  got="$(rd memory.high) $(rd memory.max) $(rd memory.swap.max) $(rd cpu.weight) $iov"
  if [ "$got" != "$want" ]; then
    unlimited "the limits did not land on the cgroup of $slice (wanted: $want; found: $got)"; return 0
  fi
  cgflag="--cgroup-parent=$slice"
  echo "[deploy] host: build limited in $slice (memory.high $(rd memory.high), memory.max $(rd memory.max), swap.max $(rd memory.swap.max), cpu.weight $(rd cpu.weight), io.weight $iov)"
}

oom_count() { local n; n=$(sed -n 's/^oom_kill //p' "$cgroot/$slice/memory.events" 2>/dev/null | head -n 1) || true; echo "${n:-0}"; }
oom_note() {
  [ "$(oom_count)" -le "$oom0" ] ||
    echo "[deploy] host: the build ran out of memory (memory.max $max); raise DOZO_DEPLOY_BUILD_MEMORY_MAX in the deploy settings" >&2
}

# A rebuild gives the app image a new id even when every step comes from cache, and a new id
# restarts its containers. dozo/app:<tag> is tagged last, so finding all three means a whole set.
if docker image inspect "dozo/app:$tag" "dozo/supervisor:$tag" "rakazo/computer:$tag" >/dev/null 2>&1; then
  echo "[deploy] host: the images of $tag are there, nothing to build"
  exit 0
fi
limit_setup
if [ -n "$cgflag" ]; then
  oom0=$(oom_count)
  # A killed build step fails the build; say which setting to raise. The status stays the build's.
  trap 'rc=$?; [ "$rc" -eq 0 ] || oom_note' EXIT
fi
cd "$dir/src"
{
  docker build -q $cgflag -f infra/sandboxes/supervisor/Dockerfile -t "dozo/supervisor:$tag" .
  docker build -q $cgflag -t "rakazo/computer:$tag" infra/sandboxes/computer
  docker build -q $cgflag --build-arg "GIT_SHA=$tag" -f infra/compose/Dockerfile -t "dozo/app:$tag-base" .
  # The theme ships inside the image, so a tag is one artefact and a rollback restores it too.
  printf 'FROM dozo/app:%s-base\nCOPY theme.json /theme/theme.json\n' "$tag" |
    docker build -q $cgflag -t "dozo/app:$tag" -f - "$dir/theme"
  docker image rm "dozo/app:$tag-base"
} >/dev/null
HOST
}

# build_images <dir> <tag>: needs build_limit_validate to have run.
build_images() {
  remote bash -s -- "$1" "$2" "$build_limit_mode" "$build_limit_high" "$build_limit_max" \
    "$build_limit_cpu" "$build_limit_io" <<<"$(build_host_script)" || die "the image build failed"
}
