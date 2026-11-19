#!/usr/bin/env bash
# Offline checks of what compose.deploy.yml gives the panel, read from `docker compose config` of
# upstream's compose file with this layer (no daemon, no .env read). Run by `gate.sh olc`.
# Usage: compose.deploy.test.sh [layer file]. Exit 0 all pass, 1 a case failed (each is printed).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAYER="${1:-$REPO/dozo/deploy/compose.deploy.yml}"
FAILED=0
bad() { FAILED=1; echo "[compose.test] FAIL: $*"; }

# config [VAR=value...]: the merged project as JSON, with the variables a deploy always sets
# (placeholders for the required secrets).
config() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" DOCKER_CONFIG="${DOCKER_CONFIG:-${HOME:-/tmp}/.docker}" \
    RAKAZO_HOST=dozo.example DOZO_IMAGE_TAG=test COMPOSE_PROJECT_NAME=dozo POSTGRES_PASSWORD=x \
    POSTGRES_APP_PASSWORD=x SANDBOX_SUPERVISOR_TOKEN=x SCREEN_PROXY_SECRET=x "$@" \
    docker compose --env-file /dev/null -p dozo -f "$REPO/infra/compose/docker-compose.yml" \
    -f "$LAYER" config --format json
}
# label <json> <service> <key>
label() { jq -r --arg s "$2" --arg k "$3" '.services[$s].labels[$k] // empty' <<<"$1"; }
envv() { jq -r --arg s "$2" --arg k "$3" '.services[$s].environment[$k] // "<unset>"' <<<"$1"; }

base=$(config) || { echo "[compose.test] FAIL: docker compose config"; exit 1; }
set_=$(config TRUSTED_PROXIES=dokploy-traefik DOZO_ORIGIN_SOURCE_RANGE=198.51.100.0/24,2001:db8::/32 \
  DOZO_PLUGIN_SUBMISSIONS=open) || { echo "[compose.test] FAIL: docker compose config (variables set)"; exit 1; }

# The API's trusted proxies come from the panel; unset leaves upstream's default.
[ "$(envv "$base" api TRUSTED_PROXIES)" = "" ] || bad "TRUSTED_PROXIES unset: want empty, got '$(envv "$base" api TRUSTED_PROXIES)'"
[ "$(envv "$set_" api TRUSTED_PROXIES)" = "dokploy-traefik" ] || bad "TRUSTED_PROXIES does not reach the api"

# Plugin submissions are closed in the api unless the panel opens them.
[ "$(envv "$base" api DOZO_PLUGIN_SUBMISSIONS)" = "closed" ] || bad "DOZO_PLUGIN_SUBMISSIONS: want closed by default, got '$(envv "$base" api DOZO_PLUGIN_SUBMISSIONS)'"
[ "$(envv "$set_" api DOZO_PLUGIN_SUBMISSIONS)" = "open" ] || bad "DOZO_PLUGIN_SUBMISSIONS does not reach the api"

# Every router of this layer but the closed one goes through its container's origin allowlist,
# which lets everyone in unless DOZO_ORIGIN_SOURCE_RANGE is set.
for svc in api web; do
  origin="dozo-${svc/web/app}-origin"
  range="traefik.http.middlewares.$origin.ipallowlist.sourcerange"
  [ "$(label "$base" "$svc" "$range")" = "0.0.0.0/0,::/0" ] || bad "$origin: want everyone by default, got '$(label "$base" "$svc" "$range")'"
  [ "$(label "$set_" "$svc" "$range")" = "198.51.100.0/24,2001:db8::/32" ] || bad "$origin: DOZO_ORIGIN_SOURCE_RANGE does not reach it"
  routers=$(jq -r --arg s "$svc" '.services[$s].labels | keys[] | capture("^traefik\\.http\\.routers\\.(?<r>[^.]+)\\.rule$").r' <<<"$base")
  [ -n "$routers" ] || bad "$svc: no routers"
  for r in $routers; do
    [ "$r" = dozo-api-closed ] && continue
    case ",$(label "$base" "$svc" "traefik.http.routers.$r.middlewares")," in
      *",$origin,"*) ;; *) bad "router $r does not use $origin" ;;
    esac
  done
done

# The app's pages and assets send Referrer-Policy strict-origin-when-cross-origin; shared pages
# keep no-referrer and nothing stricter is overridden there.
referrer() { # router -> the referrer policies of its middlewares, in order
  local m
  for m in $(label "$base" web "traefik.http.routers.$1.middlewares" | tr ',' ' '); do
    label "$base" web "traefik.http.middlewares.$m.headers.referrerPolicy"
  done | paste -sd, -
}
for r in dozo-app dozo-app-assets; do
  [ "$(referrer "$r")" = "strict-origin-when-cross-origin" ] || bad "$r: Referrer-Policy want strict-origin-when-cross-origin, got '$(referrer "$r")'"
done
[ "$(referrer dozo-app-shared)" = "no-referrer" ] || bad "dozo-app-shared: Referrer-Policy want no-referrer only, got '$(referrer dozo-app-shared)'"

[ "$FAILED" = 0 ] && echo "[compose.test] ok"
exit "$FAILED"
