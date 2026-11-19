#!/usr/bin/env bash
# Offline token benchmark (make token-kiyas). Runs the fixed task set in
# packages/testkit/src/evals/dozo-token-bench*.ts through the real runtime against a fake model,
# in Docker with no network and no keys, prints the difference from dozo/metrics/token-baseline.json,
# rewrites it, and ends with `TOKEN: giris=N cikis=N onbellek_okuma=%NN`.
# Pricing is optional and never invented: DOZO_TOKEN_PRICING=<file> with an EvalPricing JSON
# (USD per million: source, version, input, output, cacheRead, cacheWrite); without it cost is null.
# It measures what ships: the working tree's files (tracked and untracked, not ignored) are copied
# into the container and the brand rules (dozo/brand/apply.mjs --strict) are applied to that copy,
# as the unit gate's stage is. Dependencies come read-only from the unit gate's volume (dozo-qa-deps,
# filled by gate.sh unit), linked into the copy, so nothing is written there.
# Exit 0 done, 2 failure.
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${DOZO_NODE_IMAGE:-node:24.22-slim}
vol=${DOZO_TOKEN_DEPS_VOLUME:-dozo-qa-deps}
fail() { echo "[token-kiyas] $*" >&2; echo "TOKEN: FAIL"; exit 2; }
command -v docker >/dev/null || fail "docker missing"
docker image inspect "$image" >/dev/null 2>&1 || fail "no $image locally: docker pull $image"
docker volume inspect "$vol" >/dev/null 2>&1 || fail "no $vol volume: run dozo/docker/gate.sh unit once"
pricing=()
if [ -n "${DOZO_TOKEN_PRICING:-}" ]; then
  [ -f "$DOZO_TOKEN_PRICING" ] || fail "pricing file not found"
  pricing=(-v "$(cd "$(dirname "$DOZO_TOKEN_PRICING")" && pwd)/$(basename "$DOZO_TOKEN_PRICING"):/pricing.json:ro")
fi
want=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
git ls-files -z -co --exclude-standard | tar --null --ignore-failed-read -T - -cf - 2>/dev/null |
docker run -i --rm --cpus 3 --memory 6g --network none --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/repo:ro" -v "$vol:/deps:ro" -v "$PWD/dozo/metrics:/out" "${pricing[@]}" \
  -e WANT="$want" -e PRICED="${DOZO_TOKEN_PRICING:+1}" "$image" sh -c '
  set -e
  [ "$(cat /deps/w/node_modules/.dozo-deps 2>/dev/null)" = "$WANT" ] ||
    { echo "[token-kiyas] the deps volume is for another lockfile: run dozo/docker/gate.sh unit" >&2; exit 2; }
  mkdir /tmp/w && cd /tmp/w
  tar -xf -
  node /repo/dozo/brand/apply.mjs --root /tmp/w --strict --config /repo/dozo/brand/brand.json >/dev/null ||
    { echo "[token-kiyas] brand rules failed: make olc names the rule" >&2; exit 2; }
  ln -s /deps/w/node_modules node_modules
  for d in /deps/w/packages/*/node_modules; do p=${d#/deps/w/}; [ -d "${p%/node_modules}" ] && cp -a "$d" "$p"; done
  cp -a /deps/w/packages/db/src/generated packages/db/src/generated
  node_modules/.bin/tsx dozo/metrics/token-kiyas.ts /out/token-baseline.json ${PRICED:+/pricing.json}
' || fail "benchmark failed"
