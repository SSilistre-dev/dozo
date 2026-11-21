#!/usr/bin/env bash
# Keeps the api and web answering while the panel replaces them. The panel runs `docker compose
# up`, which stops every changed container before it starts any new one, and starts the api only
# after the migrations: half a minute or more in which the proxy has nothing to send requests to.
#
#   up       copies the running api and web, as they are (same image, environment, volumes and
#            networks, the same proxy labels, no Compose labels), into <project>-bridge-api and
#            <project>-bridge-web, and waits until both pass their health check. The proxy merges
#            services of the same name, so each copy joins the service of the container it was
#            made from. Then it takes each original out of the proxy and stops it, so the panel's
#            stop finds nothing the proxy still routes to, and leaves `watch` running. The previous
#            release keeps serving from the copies, which the migrations must allow anyway.
#   watch    runs on the host by itself, detached from whoever started it: retires each copy once
#            its service runs healthy again; starts an original again when the panel has not
#            replaced it within DOZO_BRIDGE_RESTORE_AFTER seconds (default 900) of its stop, so a
#            deploy that never reached the panel ends with the stack as it was. Ends when no copy
#            is left, or after DOZO_BRIDGE_WAIT seconds (default 14400, longer than a worker's
#            50-minute drain, during which Compose starts nothing new). One runs at a time.
#   restore  starts the stopped originals now (a deploy that failed before the panel started).
#   wait     waits up to <seconds> for the copies to be gone; exit 1 when some are left.
#   spec     prints the body that creates the copy of <service> from that container's `docker
#            inspect` object on stdin (compose.deploy.test.sh checks it).
#
# Out of the proxy means failing its health check: a container that just stops is still routed to
# for the moment the proxy takes to apply the event, and a request sent to its address then hangs
# instead of being refused. The checks of compose.deploy.yml and of the copies fail while
# /dev/shm/dozo-drain exists, which a new start of the container clears.
#
# Runs on the host from a file (deploy.sh copies it next to host-jobs.sh): `bridge.sh <action>
# <project> [seconds]`. Needs curl, jq, flock and setsid there. The copy is made through the Docker
# socket, so the environment, which holds secrets, never leaves the host and never becomes a
# command argument. Exit 0; 1 when a copy could not be made, is still serving, or is left; 64 on a
# usage error.
set -euo pipefail

usage() {
  echo "usage: bridge.sh up|watch|restore <project> | wait <project> <seconds> | spec api|web" >&2
  exit 64
}
case ${1:-}:$# in up:2 | watch:2 | restore:2 | spec:2 | wait:3) ;; *) usage ;; esac
action=$1 project=$2
socket=${DOCKER_SOCKET:-/var/run/docker.sock}
marker=/dev/shm/dozo-drain
status=0

# spec <service>: the container to create, from the inspect object of the one it copies. The same
# image, command, environment, volumes, limits and networks; of the labels the proxy's, and which
# container it stands in for; no Compose label, so Compose neither replaces nor removes it; no
# published port, no DNS alias. It restarts with Docker, like the original.
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
      Labels: ((.Config.Labels // {} | with_entries(select(.key | startswith("traefik."))))
        + {"dozo.bridge.original": .Id}),
      Healthcheck: {Test: ["CMD-SHELL", $check], Interval: 3000000000, Timeout: 3000000000,
        Retries: 3, StartPeriod: 60000000000, StartInterval: 1000000000},
      HostConfig: (.HostConfig | del(.PortBindings) | .RestartPolicy = {Name: "unless-stopped"}),
      NetworkingConfig: {EndpointsConfig: (.NetworkSettings.Networks | map_values({}))}
    }'
}
[ "$action" != spec ] || {
  spec "$project"
  exit
}

# Also into DOZO_BRIDGE_LOG; a caller that went away (its connection dropped) changes nothing.
say() {
  local line
  line=$(printf '[deploy] host: %s %s' "$(date -u +%H:%M:%S)" "$*")
  printf '%s\n' "$line" 2>/dev/null || true
  [ "${DOZO_BRIDGE_LOG:-/dev/null}" = /dev/null ] || printf '%s\n' "$line" >>"$DOZO_BRIDGE_LOG" 2>/dev/null || true
}
# Run to the end even when the ssh session that started it closes.
trap '' HUP PIPE
engine() {
  local method=$1 path=$2
  shift 2
  curl -fsS --unix-socket "$socket" -X "$method" "$@" "http://docker$path"
}
service_container() {
  docker ps -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=$1" | sed -n 1p
}
copies() { docker ps -aq -f "name=^$project-bridge-"; }
copy() { docker ps -aq -f "name=^$project-bridge-$1\$"; }
state() { docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null; }
healthy() { [ -n "$1" ] && case $(state "$1") in "running healthy" | "running none") true ;; *) false ;; esac; }
out_of_proxy() { [ "$(state "$1")" != "running healthy" ]; }
no_copies() { [ -z "$(copies)" ]; }
await() { # await <seconds> <command...>
  local limit=$1 waited=0
  shift
  until "$@"; do
    [ "$waited" -lt "$limit" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}
# A container whose health check knows the marker (started from compose.deploy.yml of this change
# or later, or a copy).
drainable() { docker inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{end}}' "$1" | grep -qF "$marker"; }
unmark() { docker exec "$1" rm -f "$marker" 2>/dev/null || true; }

# Every change to the copies and originals happens under one lock per project, so `up`, `watch`
# and `restore` never act on the same container at once.
lock() {
  exec 9>"${TMPDIR:-/tmp}/dozo-bridge-$project.lock"
  flock 9
}
unlock() { flock -u 9; }

# take_out <container>...: mark them all, wait until each fails its check, then give the proxy a
# moment to apply it (it reads container events as they happen).
take_out() {
  local id
  for id in "$@"; do docker exec "$id" touch "$marker" || say "WARNING: could not mark $id"; done
  for id in "$@"; do await 60 out_of_proxy "$id" || say "WARNING: $id still passes its health check"; done
  sleep 3
}

retire() { # retire <service>...: take the copies out of the proxy, then stop and remove them
  local names=() service name
  for service in "$@"; do names+=("$project-bridge-$service"); done
  [ ${#names[@]} -gt 0 ] || return 0
  take_out "${names[@]}"
  for name in "${names[@]}"; do
    docker stop -t 30 "$name" >/dev/null
    docker rm -v "$name" >/dev/null
    say "$name retired"
  done
}

# A marker on a running original that nothing is taking out (an `up` that stopped half-way) would
# keep it out of the proxy for good. Called under the lock, where no `up` is running.
clear_stale_markers() {
  local service id
  for service in api web; do
    id=$(service_container "$service")
    [ -z "$id" ] || unmark "$id"
  done
}

epoch() { date -d "$1" +%s; }
original_of() { docker inspect -f '{{index .Config.Labels "dozo.bridge.original"}}' "$1"; }
overdue() { # overdue <copy> [now]: the copy has served DOZO_BRIDGE_RESTORE_AFTER seconds (or `now`)
  [ "${2:-}" = now ] ||
    [ $(($(date +%s) - $(epoch "$(docker inspect -f '{{.Created}}' "$1")"))) -ge "${DOZO_BRIDGE_RESTORE_AFTER:-900}" ]
}

# replaced <service> [now]: the service runs healthy in a container that took over from the copy:
# a new one (the panel's), or the original started again after the copy was made, or the original
# that was never stopped (a container from before this change) once the copy is overdue.
replaced() {
  local name current original
  name=$(copy "$1")
  current=$(service_container "$1")
  healthy "$current" || return 1
  original=$(original_of "$name")
  case $original in "$current"* | "${current:-none}") ;; *) return 0 ;; esac
  [ "$(epoch "$(docker inspect -f '{{.State.StartedAt}}' "$current")")" -gt \
    "$(epoch "$(docker inspect -f '{{.Created}}' "$name")")" ] || overdue "$name" "${2:-}"
}

# originals_to_start [now]: the originals the panel has not replaced (still there, stopped) for
# DOZO_BRIDGE_RESTORE_AFTER seconds since they stopped, or at once with `now`.
originals_to_start() {
  local service name original stopped
  for service in api web; do
    name=$(copy "$service")
    [ -n "$name" ] || continue
    original=$(original_of "$name")
    [ "$(docker inspect -f '{{.State.Status}}' "$original" 2>/dev/null)" = exited ] || continue
    stopped=$(epoch "$(docker inspect -f '{{.State.FinishedAt}}' "$original")")
    if [ "${1:-}" = now ] || [ $(($(date +%s) - stopped)) -ge "${DOZO_BRIDGE_RESTORE_AFTER:-900}" ]; then
      echo "$original"
    fi
  done
}

# One pass: retire the copies whose service took over, start the originals nobody replaced.
step() {
  local service ready=() originals
  clear_stale_markers
  for service in api web; do
    [ -n "$(copy "$service")" ] || continue
    if replaced "$service" "${1:-}"; then ready+=("$service"); fi
  done
  retire ${ready[@]+"${ready[@]}"}
  originals=$(originals_to_start "${1:-}")
  if [ -n "$originals" ]; then
    # shellcheck disable=SC2086 # one id per word
    docker start $originals >/dev/null
    say "the panel did not replace the originals: started them again"
  fi
}

start_watch() {
  setsid nohup bash "$(readlink -f "$0")" watch "$project" >/dev/null 2>&1 </dev/null 9>&- &
}

case $action in
  wait)
    if await "$3" no_copies; then
      say "no copy left"
    else
      say "WARNING: still serving: $(docker ps -a --format '{{.Names}}' -f "name=^$project-bridge-" | paste -sd ' ' -)"
      status=1
    fi
    ;;
  restore)
    lock
    step now
    ;;
  watch)
    exec 8>"${TMPDIR:-/tmp}/dozo-bridge-$project.watch"
    flock -n 8 || exit 0
    say "watching the copies of $project"
    deadline=$(($(date +%s) + ${DOZO_BRIDGE_WAIT:-14400}))
    while ! no_copies && [ "$(date +%s)" -lt "$deadline" ]; do
      lock
      step
      unlock
      sleep 2
    done
    no_copies || {
      say "WARNING: gave up watching; copies left: $(copies | paste -sd ' ' -)"
      status=1
    }
    ;;
  up)
    lock
    clear_stale_markers
    stale=() originals=() marked=()
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
    retire ${stale[@]+"${stale[@]}"}
    for service in api web; do
      source=$(service_container "$service")
      healthy "$source" || continue
      name=$project-bridge-$service
      if engine GET "/containers/$source/json" | spec "$service" |
        engine POST "/containers/create?name=$name" -H 'content-type: application/json' --data-binary @- >/dev/null &&
        engine POST "/containers/$name/start" >/dev/null && await 120 healthy "$name"; then
        say "$name serving beside $service"
        if drainable "$source"; then originals+=("$source"); fi
      else
        say "WARNING: $name did not become healthy; $service is replaced without it"
        docker rm -f "$name" >/dev/null 2>&1 || true
        status=1
      fi
    done
    # From here on, whatever happens to this run, the copies get retired and the originals back.
    no_copies || start_watch
    sleep 3
    # A container started before this change has no marker in its check: the panel stops it.
    if [ ${#originals[@]} -gt 0 ]; then
      marked=("${originals[@]}")
      trap 'for id in ${marked[@]+"${marked[@]}"}; do unmark "$id"; done' EXIT
      take_out "${originals[@]}"
      docker stop "${originals[@]}" >/dev/null
      marked=()
      say "the original api and web are out of the proxy and stopped (${#originals[@]})"
    fi
    ;;
esac
exit "$status"
