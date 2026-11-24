#!/usr/bin/env bash
# deploy-ship.sh against a real Docker of the host's version: a throwaway docker-in-docker plays the
# host (DOZO_SHIP_DIND_IMAGE, default docker:28.4.0-dind, the version the host runs; bash and zstd are
# added to it), and this machine's Docker builds small images laid out like the three real ones. Checks a
# first send (every layer), a second commit (only its own layers), the ids, a container from the
# loaded image, a connection cut halfway, a damaged archive and a host without room. Run it when the
# host's Docker version changes; not part of `olc` (it needs Docker, the network for bash and about
# a minute). Removes the container, image and folder it made, by name.
# Usage: deploy-ship.dind.sh. Exit 0 all pass, 2 a case failed (each is printed).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=${DOZO_SHIP_DIND_IMAGE:-docker:28.4.0-dind}
NAME=dozo-ship-dind-$$
IMG=dozo-ship-dind:$$
WORK=$(mktemp -d "$HOME/.dozo-ship-dind.XXXXXX")
A=aaaaaaaaaaa1 B=bbbbbbbbbbb2
FAILED=0
bad() { FAILED=1; echo "[ship.dind] FAIL: $*"; }
cleanup() {
  docker rm -f "$NAME" "$NAME-small" >/dev/null 2>&1
  for t in $A $B; do for r in dozo/supervisor rakazo/computer dozo/app; do docker image rm "$r:$t" >/dev/null 2>&1; done; done
  docker image rm "$IMG" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'FROM %s\nRUN apk add --no-cache bash zstd\n' "$BASE" | docker build -q -t "$IMG" - >/dev/null || { echo "[ship.dind] cannot build $IMG"; exit 2; }
docker run -d --privileged --name "$NAME" "$IMG" >/dev/null || exit 2
until docker exec "$NAME" docker info >/dev/null 2>&1; do sleep 1; done

# A stage laid out like the real one: the three Dockerfiles at their paths, one shared base image.
mkdir -p "$WORK/stage/src/infra/sandboxes/supervisor" "$WORK/stage/src/infra/sandboxes/computer" "$WORK/stage/src/infra/compose"
echo '{}' >"$WORK/stage/theme.json"
printf 'FROM alpine:latest\nRUN head -c 3000000 /dev/urandom >/deps\nCOPY version /v\n' >"$WORK/stage/src/infra/sandboxes/supervisor/Dockerfile"
printf 'FROM alpine:latest\nRUN head -c 3000000 /dev/urandom >/computer\n' >"$WORK/stage/src/infra/sandboxes/computer/Dockerfile"
printf 'FROM alpine:latest\nARG GIT_SHA\nRUN head -c 3000000 /dev/urandom >/deps\nCOPY version /v\n' >"$WORK/stage/src/infra/compose/Dockerfile"

# The "deploy" process. CUT=<bytes>: the connection drops after that many bytes of the load.
cat >"$WORK/driver.sh" <<DRV
set -Eeuo pipefail
. "$HERE/deploy-ship.sh"
say() { printf '[deploy] %s\n' "\$*"; }
die() { printf '[deploy] FAIL: %s\n' "\$*" >&2; exit 2; }
trap 'die "line \$LINENO: \$BASH_COMMAND"' ERR
host=\${HOST:-$NAME}
remote() {
  if [ -n "\${CUT:-}" ] && case "\$*" in *"docker load"*) true ;; *) false ;; esac; then
    head -c "\$CUT" | docker exec -i "\$host" sh -c "\$*"
    return 255
  fi
  docker exec -i "\$host" sh -c "\$*"
}
stage="$WORK/stage"
ship_validate
eval "\$1"
DRV
run() { out=$(env "${@:2}" bash "$WORK/driver.sh" "$1" 2>&1); rc=$?; printf '%s\n' "$out" | sed 's/^/    /'; }
hid() { docker exec "${2:-$NAME}" docker image inspect -f '{{.Id}}' "$1" 2>/dev/null; }

echo "[ship.dind] first commit, empty host"
echo one >"$WORK/stage/src/version"
run "ship_build $A; ship_send $A"
[ "$rc" = 0 ] || bad "first send: exit $rc"
case $out in *"(0 layers are there already)"* | *"; 0 layers are there already)"*) ;; *) bad "first send: some layer was left out on an empty host" ;; esac
docker exec "$NAME" docker run --rm "dozo/app:$A" cat /v | grep -qx one || bad "first send: the loaded app image does not run"

echo "[ship.dind] second commit: only its own layers"
echo two >"$WORK/stage/src/version"
run "ship_build $B; ship_send $B"
[ "$rc" = 0 ] || bad "second send: exit $rc"
case $out in *"; 3 layers are there already)"*) ;; *) bad "second send: want the 3 layer files the host has (base, supervisor deps, computer) left out" ;; esac
for r in dozo/supervisor rakazo/computer dozo/app; do
  [ "$(hid "$r:$B")" = "sha256:$(docker save "$r:$B" | tar -xO manifest.json | jq -r '.[0].Config' | sed 's#.*/##')" ] ||
    bad "second send: the host's $r:$B is not the image built here"
done
docker exec "$NAME" docker run --rm "dozo/app:$B" cat /v | grep -qx two || bad "second send: the loaded app image does not run"
docker exec "$NAME" docker image inspect "dozo/app:$A" >/dev/null 2>&1 || bad "second send: the previous release's image is gone"

echo "[ship.dind] a connection cut halfway, then a retry"
docker exec "$NAME" sh -c "docker image rm dozo/app:$B dozo/supervisor:$B rakazo/computer:$B" >/dev/null
run "ship_send $B" CUT=2000000
[ "$rc" = 2 ] || bad "cut: want exit 2, got $rc"
[ -z "$(hid "dozo/app:$B")" ] || bad "cut: dozo/app:$B is on the host after a cut load"
docker exec "$NAME" sh -c 'ls /var/lib/docker/tmp 2>/dev/null' | grep -q . && bad "cut: the load left files in Docker's temporary folder"
run "ship_send $B"
[ "$rc" = 0 ] && [ -n "$(hid "dozo/app:$B")" ] || bad "cut: the retry did not load"

echo "[ship.dind] a damaged archive"
docker exec "$NAME" sh -c "docker image rm dozo/app:$B dozo/supervisor:$B rakazo/computer:$B" >/dev/null
printf 'zstd() { if [ "${1:-}" = -q ]; then command zstd "$@" | { head -c 4000; printf garbage; cat >/dev/null; }; else command zstd "$@"; fi; }\n' >"$WORK/damage.sh"
run ". $WORK/damage.sh; ship_send $B"
[ "$rc" = 2 ] && [ -z "$(hid "dozo/app:$B")" ] || bad "damaged: want exit 2 and no tag, got $rc"

echo "[ship.dind] a host without room"
docker run -d --privileged --name "$NAME-small" --tmpfs /var/lib/docker:size=600m "$IMG" >/dev/null
until docker exec "$NAME-small" docker info >/dev/null 2>&1; do sleep 1; done
run "ship_build $B; ship_send $B" HOST="$NAME-small"
[ "$rc" = 2 ] || bad "no room: want exit 2, got $rc"
case $out in *"nothing was sent"*) ;; *) bad "no room: no refusal before sending" ;; esac

[ "$FAILED" = 0 ] && echo "[ship.dind] PASS ($BASE)" || { echo "[ship.dind] FAIL ($BASE)"; exit 2; }
