#!/usr/bin/env bash
# Keeps the api and web answering while the panel replaces them. The panel runs `docker compose
# up`, which stops every changed container before it starts any new one, and starts the api only
# after the migrations: half a minute or more in which the proxy has nothing to send requests to.
#
#   up    copies the running api and web, as they are (same image, environment, volumes and
#         networks, the same proxy labels, no Compose labels), into <project>-bridge-api and
#         <project>-bridge-web, and waits until both pass their health check. The proxy merges
#         services of the same name, so each copy joins the service of the container it was made
#         from. Then it takes each original out of the proxy and stops it, so the panel's stop
#         finds nothing the proxy still routes to. The previous release keeps serving from the
#         copies, which the migrations must allow anyway (root AGENTS.md).
#   down  for each copy whose service runs healthy again: takes the copy out of the proxy, then
#         stops and removes it. A copy whose service is not healthy (a failed deploy) stays and
#         keeps serving; the next `down` or `up` takes it away once the service is back.
#   spec  prints the body that creates the copy of <service> from that container's `docker inspect`
#         object on stdin (compose.deploy.test.sh checks it).
#
# Out of the proxy means failing its health check: a container that just stops is still routed to
# for the moment the proxy takes to apply the event, and a request sent to its address then hangs
# instead of being refused. The health checks of compose.deploy.yml and of the copies fail while
# /dev/shm/dozo-drain exists, which a new start of the container clears.
#
# Runs on the host, piped over ssh by deploy.sh: `bash -s -- up|down <project>`. Needs curl and jq
# there (the copy is made through the Docker socket, so the environment, which holds secrets, never
# leaves the host and never becomes a command argument). Exit 0, 1 when a copy could not be made or
# was kept, 64 on a usage error.
set -euo pipefail

[ $# -eq 2 ] && case $1 in up | down | spec) true ;; *) false ;; esac || {
  echo "usage: bridge.sh up|down <compose project> | spec api|web" >&2
  exit 64
}
action=$1 project=$2
socket=${DOCKER_SOCKET:-/var/run/docker.sock}
marker=/dev/shm/dozo-drain
status=0

# spec <service>: the container to create, from the inspect object of the one it copies. The same
# image, command, environment, volumes, limits and networks; of the labels only the proxy's, so
# Compose does not count the copy as one of its own; no restart, no published port, no DNS alias.
spec() {
  local port path
  case $1 in
    api) port=3100 path=/health ;;
    web) port=5173 path=/ ;;
    *) return 64 ;;
  esac
  local check="test ! -e $marker && node -e \"fetch('http://127.0.0.1:$port$path').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
  jq --arg check "$check" '
    {
      Image: .Image,
      Env: .Config.Env, Cmd: .Config.Cmd, Entrypoint: .Config.Entrypoint,
      WorkingDir: .Config.WorkingDir, User: .Config.User, StopSignal: .Config.StopSignal,
      ExposedPorts: .Config.ExposedPorts,
      Labels: (.Config.Labels // {} | with_entries(select(.key | startswith("traefik.")))),
      Healthcheck: {Test: ["CMD-SHELL", $check], Interval: 1000000000, Timeout: 3000000000,
        Retries: 2, StartPeriod: 60000000000},
      HostConfig: (.HostConfig | del(.PortBindings) | .RestartPolicy = {Name: "no"}),
      NetworkingConfig: {EndpointsConfig: (.NetworkSettings.Networks | map_values({}))}
    }'
}
[ "$action" != spec ] || {
  spec "$project"
  exit
}

say() { printf '[deploy] host: %s\n' "$*"; }
engine() {
  local method=$1 path=$2
  shift 2
  curl -fsS --unix-socket "$socket" -X "$method" "$@" "http://docker$path"
}
service_container() {
  docker ps -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=$1" | head -1
}
state() { docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null; }
healthy() { [ -n "$1" ] && case $(state "$1") in "running healthy" | "running none") true ;; *) false ;; esac; }
# await <seconds> <command...>: until the command succeeds, at most that long.
await() {
  local limit=$1 waited=0
  shift
  until "$@"; do
    [ "$waited" -lt "$limit" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}
service_healthy() { healthy "$(service_container "$1")"; }
out_of_proxy() { [ "$(state "$1")" != "running healthy" ]; }
# A container whose health check knows the marker (one started from compose.deploy.yml of this
# change or later, or a copy).
drainable() { docker inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{end}}' "$1" | grep -qF "$marker"; }

# take_out <container>...: mark them all, wait until each fails its check, then give the proxy a
# moment to apply it (it reads container events as they happen).
take_out() {
  local id
  for id in "$@"; do docker exec "$id" touch "$marker" || say "WARNING: could not mark $id"; done
  for id in "$@"; do await 60 out_of_proxy "$id" || say "WARNING: $id still passes its health check"; done
  sleep 3
}

make_copy() {
  local service=$1 source=$2 name=$3
  engine GET "/containers/$source/json" | spec "$service" |
    engine POST "/containers/create?name=$name" -H 'content-type: application/json' --data-binary @- >/dev/null
  engine POST "/containers/$name/start" >/dev/null
}

retire_copies() {
  local names=() service name
  for service in "$@"; do names+=("$project-bridge-$service"); done
  [ ${#names[@]} -gt 0 ] || return 0
  take_out "${names[@]}"
  for name in "${names[@]}"; do
    docker stop -t 30 "$name" >/dev/null
    docker rm "$name" >/dev/null
    say "$name retired"
  done
}

copy() { docker ps -aq -f "name=^$project-bridge-$1\$"; }

if [ "$action" = down ]; then
  ready=()
  for service in api web; do
    [ -n "$(copy "$service")" ] || continue
    if await "${DOZO_BRIDGE_WAIT:-300}" service_healthy "$service"; then
      ready+=("$service")
    else
      say "WARNING: $project-bridge-$service keeps serving the previous release: $service is not healthy"
      status=1
    fi
  done
  retire_copies ${ready[@]+"${ready[@]}"}
  exit "$status"
fi

stale=() originals=()
for service in api web; do
  source=$(service_container "$service")
  if healthy "$source"; then
    [ -z "$(copy "$service")" ] || stale+=("$service")
  elif healthy "$(copy "$service")"; then
    say "$project-bridge-$service is still serving (left from a deploy that failed)"
  else
    say "WARNING: no copy of $service: it is not running healthy"
    status=1
  fi
done
retire_copies ${stale[@]+"${stale[@]}"}
for service in api web; do
  source=$(service_container "$service")
  healthy "$source" || continue
  name=$project-bridge-$service
  if make_copy "$service" "$source" "$name" && await 120 healthy "$name"; then
    say "$name serving beside $service"
    drainable "$source" && originals+=("$source")
  else
    say "WARNING: $name did not become healthy; $service is replaced without it"
    docker rm -f "$name" >/dev/null 2>&1 || true
    status=1
  fi
done
sleep 3
# A container started before this change has no marker in its check: the panel stops it as before.
if [ ${#originals[@]} -gt 0 ]; then
  take_out "${originals[@]}"
  docker stop "${originals[@]}" >/dev/null
  say "the original api and web are out of the proxy and stopped (${#originals[@]})"
fi
exit "$status"
