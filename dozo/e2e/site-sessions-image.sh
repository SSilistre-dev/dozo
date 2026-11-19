#!/usr/bin/env bash
# Runs dozo/e2e/site-sessions-image.py in the bot computer image: the signed-in sites script
# (packages/adapters/src/dozo-site-sessions.script.ts) against a real browser, no network.
# Exit 0 pass, 2 on any failure. Image: DOZO_COMPUTER_IMAGE (default rakazo/computer:local).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DOZO_COMPUTER_IMAGE:-rakazo/computer:local}"
NAME="dozo-site-sessions-image-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT INT TERM
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "site-sessions-image: no image $IMAGE" >&2; exit 2; }
# The image's own home: the brand renames it, and the script's profile path must match.
home="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^HOME=//p')"
[ -n "$home" ] || { echo "site-sessions-image: the image sets no HOME" >&2; exit 2; }
if docker run --rm --name "$NAME" --network none --cpus 3 --memory 6g --shm-size 512m \
  --tmpfs "$home:uid=1000,gid=1000,exec" -e HOME="$home" --entrypoint /usr/bin/env \
  -v "$ROOT/packages/adapters/src/dozo-site-sessions.script.ts:/src/dozo-site-sessions.script.ts:ro" \
  -v "$ROOT/dozo/e2e/site-sessions-image.py:/src/test.py:ro" \
  "$IMAGE" -u LD_PRELOAD timeout 300 python3 -I /src/test.py; then
  exit 0
fi
exit 2
