#!/usr/bin/env bash
# Deploys the committed tree (HEAD) to a host that a Dokploy panel manages: stage, brand, build
# the images on the host, hand the panel the merged compose file and the image tag, wait for the
# panel's deployment, then check health. Settings, first-time setup and rollback:
# dozo/deploy/README.md. Exits 2 on any failure and 64 on a usage error.
set -Eeuo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

say() { printf '[deploy] %s\n' "$*"; }
die() {
  printf '[deploy] FAIL: %s\n' "$*" >&2
  exit 2
}
trap 'die "line $LINENO: $BASH_COMMAND"' ERR

usage() {
  cat >&2 <<'EOF'
Usage: dozo/deploy/deploy.sh [deploy | rollback <tag> | owner]
  deploy          stage HEAD, brand, build on the host, deploy, check health (default)
  rollback <tag>  run a tag whose images are still on the host
  owner           create the owner's account (asks for email and password)
EOF
  exit 64
}

action=${1:-deploy}
case "$action" in
  deploy | owner) [ $# -le 1 ] || usage ;;
  rollback) [ $# -eq 2 ] || usage ;;
  *) usage ;;
esac

for tool in git rsync ssh curl jq docker; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

conf=${DOZO_DEPLOY_CONF:-$HOME/.config/dozo/deploy.conf}
[ -r "$conf" ] || die "no settings file at $conf (dozo/deploy/README.md, Settings)"
# shellcheck source=/dev/null
. "$conf"
for name in DOZO_DEPLOY_SSH DOZO_DEPLOY_DOMAIN DOKPLOY_URL DOKPLOY_COMPOSE_ID; do
  [ -n "${!name:-}" ] || die "$name is not set in $conf"
done
remote_dir=${DOZO_DEPLOY_DIR:-/opt/dozo}
timeout=${DOZO_DEPLOY_TIMEOUT:-900}
if [ -z "${DOKPLOY_API_KEY:-}" ]; then
  [ -n "${DOKPLOY_API_KEY_CMD:-}" ] || die "set DOKPLOY_API_KEY, or DOKPLOY_API_KEY_CMD in $conf"
  DOKPLOY_API_KEY=$(eval "$DOKPLOY_API_KEY_CMD") || die "DOKPLOY_API_KEY_CMD failed"
fi

# panel <procedure> [curl arguments]. The key goes through a config file descriptor, never argv.
panel() {
  local procedure=$1
  shift
  curl -fsS -m 60 -K <(printf 'header = "x-api-key: %s"\n' "$DOKPLOY_API_KEY") \
    -H 'content-type: application/json' "$@" "$DOKPLOY_URL/api/$procedure"
}

remote() { ssh -o BatchMode=yes "$DOZO_DEPLOY_SSH" "$@"; }

compose_json() { panel "compose.one?composeId=$DOKPLOY_COMPOSE_ID"; }

# The panel runs the stack under its own project name; containers are found by that label.
project_name() { compose_json | jq -er '.appName'; }

# run_tag <tag> [merged compose file]: point the panel at the tag, deploy, wait, check health.
run_tag() {
  local tag=$1 file=${2:-} current env before status project
  # The environment holds secrets: it stays in memory and in pipes, never in an argument or a file.
  current=$(compose_json)
  env=$(printf '%s' "$current" | jq -r '.env // ""')
  previous=$(printf '%s\n' "$env" | sed -n 's/^DOZO_IMAGE_TAG=//p')
  before=$(printf '%s' "$current" | jq -r '[.deployments[]?.createdAt] | max // ""')
  env=$(
    printf '%s\n' "$env" | sed '/^DOZO_IMAGE_TAG=/d'
    printf 'DOZO_IMAGE_TAG=%s\n' "$tag"
  )
  printf '%s\n' "$env" |
    if [ -n "$file" ]; then
      jq -Rs --arg id "$DOKPLOY_COMPOSE_ID" --rawfile compose "$file" \
        '{composeId: $id, env: ., composeFile: $compose, sourceType: "raw"}'
    else
      jq -Rs --arg id "$DOKPLOY_COMPOSE_ID" '{composeId: $id, env: .}'
    fi | panel compose.update --data-binary @- >/dev/null

  say "panel: deploying $tag (was ${previous:-nothing})"
  jq -n --arg id "$DOKPLOY_COMPOSE_ID" --arg title "dozo $tag" '{composeId: $id, title: $title}' |
    panel compose.deploy --data-binary @- >/dev/null

  # The panel queues the deployment: wait for a record newer than the last one to finish.
  local waited=0
  while :; do
    status=$(compose_json | jq -r --arg before "$before" \
      '[.deployments[]? | select(.createdAt > $before)] | max_by(.createdAt) | .status // "queued"' ||
      echo unreachable)
    case "$status" in
      done) break ;;
      error) die "the panel reports a failed deployment; read its log in the panel" ;;
    esac
    [ "$waited" -lt "$timeout" ] || die "the panel did not finish in ${timeout}s (last status: $status)"
    sleep 5
    waited=$((waited + 5))
  done

  project=$(project_name)
  say "host: waiting for api and worker to be healthy"
  remote bash -s -- "$project" "$tag" "$timeout" <<'EOF' || die "health check on the host failed"
set -euo pipefail
project=$1 tag=$2 timeout=$3
container() {
  docker ps -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=$1" | head -1
}
services="postgres supervisor web api worker"
for service in $services; do
  waited=0
  while :; do
    id=$(container "$service")
    state=$( [ -n "$id" ] && docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id" || echo "missing none 0")
    case "$state" in
      "running healthy "* | "running none "*) break ;;
    esac
    if [ "$waited" -ge "$timeout" ]; then
      echo "$service: $state" >&2
      [ -z "$id" ] || docker logs --tail 20 "$id" >&2
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  echo "[deploy] host: $service $state"
done
for service in api worker web supervisor; do
  image=$(docker inspect -f '{{.Config.Image}}' "$(container "$service")")
  case "$image" in
    "dozo/app:$tag" | "dozo/supervisor:$tag") ;;
    *)
      echo "$service runs $image, not tag $tag" >&2
      exit 1
      ;;
  esac
done
docker exec "$(container api)" node -e \
  "fetch('http://127.0.0.1:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
echo "[deploy] host: api /health ok"
# A service without a health check (supervisor, web) can look fine once and still be crash-looping.
restarts() {
  for service in $services; do
    docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$(container "$service")"
  done
}
first=$(restarts)
sleep 15
if [ "$(restarts)" != "$first" ] || printf '%s\n' "$first" | grep -qv '^running '; then
  echo "a service restarted or stopped within 15s" >&2
  exit 1
fi
EOF

  local url="https://$DOZO_DEPLOY_DOMAIN/" title
  waited=0
  until title=$(curl -fsS -m 20 "$url" 2>/dev/null | grep -io '<title>[^<]*' | head -1 || true) &&
    [ -n "$title" ]; do
    [ "$waited" -lt 120 ] || die "$url does not answer with a page"
    sleep 5
    waited=$((waited + 5))
  done
  printf '%s' "$title" | grep -qi 'dozo' || die "$url has the wrong title: $title"
  say "site: $url answers, title ${title#*>}"
  [ -z "$previous" ] || [ "$previous" = "$tag" ] ||
    say "to go back: dozo/deploy/deploy.sh rollback $previous"
}

if [ "$action" = owner ]; then
  project=$(project_name)
  # -t: the prompts need a terminal. The password is read on the host and never echoed.
  ssh -t "$DOZO_DEPLOY_SSH" "
    id=\$(docker ps -q -f label=com.docker.compose.project=$project -f label=com.docker.compose.service=api | head -1)
    [ -n \"\$id\" ] || { echo 'the api container is not running' >&2; exit 2; }
    read -r -p 'Account email: ' OWNER_EMAIL
    read -r -s -p 'Account password (at least 16 characters): ' OWNER_PASSWORD; echo
    export OWNER_EMAIL OWNER_PASSWORD
    docker exec -e OWNER_EMAIL -e OWNER_PASSWORD \"\$id\" node dist/cli/bootstrap-owner.js
  " || die "the account was not created"
  exit 0
fi

if [ "$action" = rollback ]; then
  tag=$2
  remote docker image inspect "dozo/app:$tag" "dozo/supervisor:$tag" "rakazo/computer:$tag" \
    >/dev/null || die "the images of $tag are not on the host"
  run_tag "$tag"
  say "DEPLOY: PASS (rollback to $tag)"
  exit 0
fi

tag=$(git -C "$repo" rev-parse --short=12 HEAD)
[ -z "$(git -C "$repo" status --porcelain)" ] || say "note: uncommitted changes are not deployed"

# Under HOME: Docker Desktop cannot mount the system temporary folder.
stage=$(mktemp -d "$HOME/.dozo-deploy.XXXXXX")
trap 'rm -rf "$stage"' EXIT
say "stage and brand $tag"
DOZO_STAGE_DIR=$stage DOZO_STAGE_WORKTREE='' DOZO_STAGE_REF=$tag "$repo/dozo/docker/build.sh" stage
DOZO_STAGE_DIR=$stage "$repo/dozo/docker/build.sh" brand
# The layer and the theme come from the same commit as the tree, not from the working tree.
git -C "$repo" show "$tag:dozo/deploy/compose.deploy.yml" >"$stage/compose.deploy.yml"
git -C "$repo" show "$tag:dozo/theme/theme.json" >"$stage/theme.json"

# An empty environment: nothing exported in this shell can end up in the file the panel stores.
merged=$stage/compose.merged.yml
env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
  ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
  docker compose -p dozo -f "$stage/src/infra/compose/docker-compose.yml" \
  -f "$stage/compose.deploy.yml" config --no-interpolate >"$merged"
# Nothing may be built by the panel or published on the host.
! grep -qE '^ +(build|ports):' "$merged" || die "the merged compose file still builds or publishes a port"

say "copy the branded tree to the host"
remote mkdir -p "$remote_dir/src" "$remote_dir/theme"
rsync -az --delete "$stage/src/" "$DOZO_DEPLOY_SSH:$remote_dir/src/"
rsync -az "$stage/theme.json" "$DOZO_DEPLOY_SSH:$remote_dir/theme/"

say "build the images on the host"
remote bash -s -- "$remote_dir" "$tag" <<'EOF' || die "the image build failed"
set -euo pipefail
dir=$1 tag=$2
# A rebuild gives the app image a new id even when every step comes from cache, and a new id
# restarts its containers. dozo/app:<tag> is tagged last, so finding all three means a whole set.
if docker image inspect "dozo/app:$tag" "dozo/supervisor:$tag" "rakazo/computer:$tag" >/dev/null 2>&1; then
  echo "[deploy] host: the images of $tag are there, nothing to build"
  exit 0
fi
cd "$dir/src"
{
  docker build -q -f infra/sandboxes/supervisor/Dockerfile -t "dozo/supervisor:$tag" .
  docker build -q -t "rakazo/computer:$tag" infra/sandboxes/computer
  docker build -q --build-arg "GIT_SHA=$tag" -f infra/compose/Dockerfile -t "dozo/app:$tag-base" .
  # The theme ships inside the image, so a tag is one artefact and a rollback restores it too.
  printf 'FROM dozo/app:%s-base\nCOPY theme.json /theme/theme.json\n' "$tag" |
    docker build -q -t "dozo/app:$tag" -f - "$dir/theme"
  docker image rm "dozo/app:$tag-base"
} >/dev/null
EOF

run_tag "$tag" "$merged"

# Keep this tag, the one it replaced and the newest other one. Tags of one image list in no
# order, so the two in use are named, never counted. A repeat of the same tag removes nothing:
# the tag it first replaced is no longer known.
[ "${previous:-}" = "$tag" ] || remote bash -s -- "$tag" "${previous:-$tag}" <<'EOF' || true
for image in dozo/app dozo/supervisor rakazo/computer; do
  docker images "$image" --format '{{.Tag}}' | grep -vxF -e "$1" -e "$2" | tail -n +2 |
    while read -r old; do
      docker image rm "$image:$old" >/dev/null 2>&1 || true
    done
done
EOF

say "DEPLOY: PASS ($tag at https://$DOZO_DEPLOY_DOMAIN/)"
