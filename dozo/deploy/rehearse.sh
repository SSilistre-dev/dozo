#!/usr/bin/env bash
# Rehearses a deploy on this machine and measures what users would see during it: the production
# layer over upstream's compose file, started as the panel starts it (`docker compose up -d
# --remove-orphans`, with the panel's own router and network added), behind the panel's proxy
# (Traefik v3.5.0, its docker provider), while outage-probe.sh watches through that proxy.
#
# It starts a release on the first layer, then replaces it with a release of new images on the
# second layer, and prints the probe's summary and the proxy's answers during the replacement:
#   plain    the panel's deploy alone, as before bridge.sh;
#   bridge   as deploy.sh runs it: `bridge.sh up`, the panel's deploy, `bridge.sh wait`;
#   abandon  the caller goes away once the panel has started (a dropped connection, a timeout):
#            nothing but bridge.sh's own `watch` retires the copies;
#   abort    the panel never deploys after `bridge.sh up`: `watch` starts the originals again
#            (after DOZO_BRIDGE_RESTORE_AFTER, 20 seconds here) and retires the copies.
# Each ends by checking that no copy is left and that api and web run healthy. Everything it creates is named after
# DOZO_REHEARSAL_PROJECT (default dozo-rehearsal) and removed at the end, its volumes too.
#
# Usage: rehearse.sh <running layer> <new layer> plain|bridge|abandon|abort
# Needs: the local stack's images (DOZO_REHEARSAL_APP_IMAGE, default dozo-api:latest;
# DOZO_REHEARSAL_SUPERVISOR_IMAGE, dozo-supervisor:latest; DOZO_REHEARSAL_COMPUTER_IMAGE,
# rakazo/computer:local, which only has to run `true` here), curl, jq, openssl. Traefik v3.5.0 cannot
# talk to Docker 29 or newer: there, point DOCKER_HOST at a docker:28 daemon (the live host's
# version) that sees this work folder at the same path, and publish the proxy on its address with
# DOZO_REHEARSAL_BIND (README, Deploys without a gap). Heavy: run it under the local stack lock.
# Exit 0 when it ran (the numbers are the result), 2 when it could not run, 64 usage.
set -Eeuo pipefail
export LC_ALL=C

[ $# -eq 3 ] && case $3 in plain | bridge | abandon | abort) true ;; *) false ;; esac || {
  echo "usage: rehearse.sh <running layer> <new layer> plain|bridge|abandon|abort" >&2
  exit 64
}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
old_layer=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
new_layer=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
mode=$3
P=${DOZO_REHEARSAL_PROJECT:-dozo-rehearsal}
port=${DOZO_REHEARSAL_PORT:-18443}
app_image=${DOZO_REHEARSAL_APP_IMAGE:-dozo-api:latest}
supervisor_image=${DOZO_REHEARSAL_SUPERVISOR_IMAGE:-dozo-supervisor:latest}
computer_image=${DOZO_REHEARSAL_COMPUTER_IMAGE:-rakazo/computer:local}
bind=${DOZO_REHEARSAL_BIND:-127.0.0.1}
host=dozo.example
work=$(mktemp -d "${BB_THREAD_STORAGE:-$HOME}/.dozo-rehearsal.XXXXXX")

say() { printf '[rehearse] %s\n' "$*"; }
die() {
  printf '[rehearse] FAIL: %s\n' "$*" >&2
  exit 2
}
trap 'die "line $LINENO: $BASH_COMMAND"' ERR

probe_pid=""
cleanup() {
  trap - ERR
  [ -z "$probe_pid" ] || kill "$probe_pid" 2>/dev/null || true
  docker rm -f "$P-traefik" "$P-bridge-api" "$P-bridge-web" >/dev/null 2>&1 || true
  [ ! -f "$work/merged-new.yml" ] ||
    dc "$work/merged-new.yml" down -v --remove-orphans -t 5 >/dev/null 2>&1 || true
  docker network rm "$P" >/dev/null 2>&1 || true
  for tag in a b; do
    docker image rm "dozo/app:$P-$tag" "dozo/supervisor:$P-$tag" "rakazo/computer:$P-$tag" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

# dc <merged file> <compose arguments...>: as the panel runs it, plus its additions.
dc() {
  local file=$1
  shift
  env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} docker compose -p "$P" --env-file "$work/env" -f "$file" \
    -f "$work/panel.yml" "$@"
}
merge() { # merge <layer> <out>: what deploy.sh hands the panel
  env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} docker compose -p "$P" -f "$repo/infra/compose/docker-compose.yml" \
    -f "$1" config --no-interpolate >"$2"
}
container() {
  docker ps -q -f "label=com.docker.compose.project=$P" -f "label=com.docker.compose.service=$1" | head -1
}
healthy() {
  local id
  id=$(container "$1")
  [ -n "$id" ] && case $(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id") in
    "running healthy" | "running none") true ;;
    *) false ;;
  esac
}
wait_for() { # wait_for <seconds> <command...>
  local limit=$1 waited=0
  shift
  until "$@"; do
    [ "$waited" -lt "$limit" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}
curl_proxy() { curl -sk --resolve "$host:$port:127.0.0.1" -m 5 "$@"; }
answers() { [ "$(curl_proxy -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "https://$host:$port/rpc/health")" = 200 ]; }

for image in "$app_image" "$supervisor_image" "$computer_image" traefik:v3.5.0; do
  docker image inspect "$image" >/dev/null 2>&1 || [ "$image" = traefik:v3.5.0 ] ||
    die "image $image is missing (build the local stack first)"
done
docker image inspect traefik:v3.5.0 >/dev/null 2>&1 || docker pull -q traefik:v3.5.0 >/dev/null

say "images: two releases of $app_image"
for tag in a b; do
  # The theme ships inside the image as deploy.sh puts it; the second release differs by a label,
  # which is enough for Compose to replace every app container.
  printf 'FROM %s\nCOPY theme.json /theme/theme.json\nLABEL dozo.rehearsal=%s\n' "$app_image" "$tag" |
    docker build -q -t "dozo/app:$P-$tag" -f - "$repo/dozo/theme" >/dev/null
  docker tag "$supervisor_image" "dozo/supervisor:$P-$tag"
  docker tag "$computer_image" "rakazo/computer:$P-$tag"
done

(
  umask 077
  for key in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY \
    SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN; do
    printf '%s=%s\n' "$key" "$(openssl rand -hex 24)"
  done >"$work/env"
)
cat >>"$work/env" <<EOF
COMPOSE_PROJECT_NAME=$P
RAKAZO_HOST=$host
BETTER_AUTH_URL=https://$host
WEB_ORIGIN=https://$host
DOZO_STACK_SUBNET=10.213.199.0/24
RAKAZO_COMPUTER_NETWORK_RANGE=10.215.0.0/16
EOF
set_tag() { sed -i '/^DOZO_IMAGE_TAG=/d' "$work/env" && echo "DOZO_IMAGE_TAG=$P-$1" >>"$work/env"; }

# What the panel adds to the file it is given: its network for an isolated deployment, which its
# proxy joins, and its router for the domain on web. Plus this machine's limit per container.
cat >"$work/panel.yml" <<EOF
x-cpus: &cpus
  cpus: 3
services:
  postgres: *cpus
  supervisor: *cpus
  worker: *cpus
  api:
    <<: *cpus
    networks: [default, panel]
  web:
    <<: *cpus
    networks: [default, panel]
    labels:
      traefik.enable: "true"
      traefik.docker.network: $P
      traefik.http.routers.$P-web.rule: Host(\`$host\`)
      traefik.http.routers.$P-web.entrypoints: websecure
      traefik.http.routers.$P-web.tls: "true"
      traefik.http.routers.$P-web.service: $P-web
      traefik.http.services.$P-web.loadbalancer.server.port: "5173"
networks:
  panel:
    name: $P
    external: true
EOF

merge "$old_layer" "$work/merged-old.yml"
merge "$new_layer" "$work/merged-new.yml"
docker network create "$P" >/dev/null
mkdir -p "$work/log"
docker run -d --name "$P-traefik" --cpus 1 --memory 512m --network "$P" -p "$bind:$port:443" \
  -v /var/run/docker.sock:/var/run/docker.sock:ro -v "$work/log:/log" traefik:v3.5.0 \
  --providers.docker=true --providers.docker.exposedbydefault=false --providers.docker.network="$P" \
  --entrypoints.websecure.address=:443 --accesslog=true --accesslog.format=json \
  --accesslog.filepath=/log/access.log --accesslog.bufferingsize=0 >/dev/null

say "running release: $(basename "$old_layer")"
set_tag a
dc "$work/merged-old.yml" up -d --remove-orphans --quiet-pull 2>&1 | grep -vE "^ *Container .* (Creat|Start|Wait|Running|Exited)" || true
wait_for 300 healthy api || die "the first release's api did not become healthy"
wait_for 120 healthy web || die "the first release's web did not become healthy"
wait_for 60 answers || die "the first release does not answer through the proxy"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$P-" | sed 's/^/[rehearse] memory: /'

say "probe: watching https://$host:$port through the proxy"
DOZO_PROBE_INTERVAL=${DOZO_PROBE_INTERVAL:-0.25} "$here/outage-probe.sh" "https://$host:$port" "$work/probe.log" \
  -k --resolve "$host:$port:127.0.0.1" >"$work/probe.out" &
probe_pid=$!
sleep 5
from=$(date -u +%Y-%m-%dT%H:%M:%S)
t0=$EPOCHREALTIME
mark() { say "at $(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.1f", b - a }')s: $*"; }

export DOZO_BRIDGE_LOG=$work/bridge.log
[ "$mode" != abort ] || export DOZO_BRIDGE_RESTORE_AFTER=20
if [ "$mode" != plain ]; then
  bash "$here/bridge.sh" up "$P" 2>&1 | while IFS= read -r line; do mark "$line"; done
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$P-" | sed 's/^/[rehearse] memory: /'
fi
mark "new release: $(basename "$new_layer") ($mode)"
set_tag b
no_copies() { [ -z "$(docker ps -aq -f "name=^$P-bridge-")" ]; }
if [ "$mode" = abort ]; then
  # The panel never runs: watch has to put the originals back.
  wait_for 300 no_copies || say "copies still there"
else
  # Compose's own steps for the api and web, timed, with anything that is not a step (an error).
  dc "$work/merged-new.yml" up -d --remove-orphans 2>&1 | while IFS= read -r line; do
    case $line in
      *Container*-api-1*Recreate* | *Container*-web-1*Recreate* | *Container*-api-1*Start* | \
        *Container*-web-1*Start* | *Container*-api-1*Healthy*) mark "compose:${line#*Container}" ;;
      *Container* | *Network* | *Volume*) ;;
      *) mark "compose: $line" ;;
    esac
  done
  mark "the panel's compose up returned"
fi
case $mode in
  bridge) bash "$here/bridge.sh" wait "$P" 300 2>&1 | while IFS= read -r line; do mark "$line"; done ;;
  # The caller is gone: only watch is left to retire the copies.
  abandon) wait_for 300 no_copies || true ;;
esac
wait_for 300 healthy api || say "api is not healthy"
wait_for 300 healthy web || say "web is not healthy"
mark "api and web healthy"
sleep 10
[ ! -f "$work/bridge.log" ] || sed 's/^\[deploy\] host: /[rehearse] watch: /' "$work/bridge.log"
say "result: copies left: $(docker ps -aq -f "name=^$P-bridge-" | wc -l); api: $(healthy api && echo healthy || echo NOT healthy), web: $(healthy web && echo healthy || echo NOT healthy)"
kill "$probe_pid"
wait "$probe_pid" || true
probe_pid=""
cat "$work/probe.out"
# Each failed request, and each that took over a second, when it was sent.
awk -v t0="$t0" '$3 == "down" || $5 > 1 { printf "[rehearse] %s: %s at %.1fs (%s in %ss)\n", ($3 == "down" ? "failed" : "slow"), $1, $2 - t0, $4, $5 }' "$work/probe.log"
say "proxy answers since $from (status x count, by router's service):"
jq -r --arg from "$from" 'select(.time >= $from) | "\(.DownstreamStatus) \(.ServiceName // "none")"' \
  "$work/log/access.log" | sort | uniq -c | sort -rn | sed 's/^/[rehearse]   /'
say "done"
