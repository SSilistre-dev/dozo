#!/usr/bin/env bash
# Runs a command for the relay Worker inside the Node image, never on the host:
#   dozo/relay/worker/docker.sh npm ci
#   dozo/relay/worker/docker.sh npm test
#   dozo/relay/worker/docker.sh npx wrangler deploy --dry-run --outdir /tmp/out
# The repository is mounted because the protocol comes from packages/. The local Workers runtime
# needs CA certificates, which the slim image lacks: the host's are mounted read-only.
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID pass through when set (deploy only).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
image="${DOZO_NODE_IMAGE:-node:24.22-slim}"
certs=/etc/ssl/certs
[ -d "$certs" ] || { echo "relay worker: $certs missing on the host" >&2; exit 2; }
tty=(); [ -t 0 ] && [ -t 1 ] && tty=(-it)
exec docker run --rm "${tty[@]}" --cpus 3 --memory 6g --name "dozo-relay-worker-$$" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 -e WRANGLER_SEND_METRICS=false \
  -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID \
  -v "$certs:/etc/ssl/certs:ro" -v "$root:/repo" -w /repo/dozo/relay/worker "$image" "$@"
