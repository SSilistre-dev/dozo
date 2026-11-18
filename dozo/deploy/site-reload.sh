#!/usr/bin/env bash
# Runs on the host, fed over ssh by `deploy.sh site`: site-reload.sh <compose project>.
# The panel leaves a running container alone when its compose file did not change, so a new
# site.nginx.conf is loaded here: test it in the running container, then reload. A config that
# fails the test is not loaded (nginx keeps serving the old one) and the exit is not zero.
set -euo pipefail
project=$1
id=$(docker ps -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=site" | head -1)
[ -n "$id" ] || {
  echo "the site container is not running" >&2
  exit 1
}
docker exec "$id" nginx -t
docker exec "$id" nginx -s reload
echo "[deploy] host: nginx config tested and reloaded"
