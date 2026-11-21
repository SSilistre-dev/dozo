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

# The hosted login keys reach the api only, and only when the panel sets them. A key that belongs
# to a computer's own server (the relay agent's) never reaches any service here.
keys=$(config HOSTED_LOGIN_SIGNING_KEY=signing-key HOSTED_LOGIN_OVERLAP_KEY=overlap-key \
  DOZO_RELAY_AGENT_KEY=relay-key) || { echo "[compose.test] FAIL: docker compose config (keys set)"; exit 1; }
for k in HOSTED_LOGIN_SIGNING_KEY HOSTED_LOGIN_OVERLAP_KEY; do
  want=$([ "$k" = HOSTED_LOGIN_SIGNING_KEY ] && echo signing-key || echo overlap-key)
  [ "$(envv "$keys" api "$k")" = "$want" ] || bad "$k does not reach the api"
  [ "$(envv "$base" api "$k")" = "<unset>" ] || bad "$k unset: want it absent from the api, got '$(envv "$base" api "$k")'"
  for svc in $(jq -r '.services | keys[]' <<<"$keys"); do
    [ "$svc" = api ] && continue
    [ "$(envv "$keys" "$svc" "$k")" = "<unset>" ] || bad "$k reaches $svc"
  done
done
for svc in $(jq -r '.services | keys[]' <<<"$keys"); do
  [ "$(envv "$keys" "$svc" DOZO_RELAY_AGENT_KEY)" = "<unset>" ] || bad "DOZO_RELAY_AGENT_KEY reaches $svc"
done

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

# The MCP endpoint's OAuth metadata goes to the api, and only that /.well-known/ path: the passkey
# association files stay on the web container. While the api is down its paths answer 502 instead
# of falling through to the web container, so that router takes the same paths.
api_rule=$(label "$base" api traefik.http.routers.dozo-api.rule)
case "$api_rule" in
  *'PathPrefix(`/.well-known/oauth-protected-resource`)'*) ;;
  *) bad "dozo-api does not take /.well-known/oauth-protected-resource: $api_rule" ;;
esac
for svc in api web; do
  for r in $(jq -r --arg s "$svc" '.services[$s].labels | keys[] | capture("^traefik\\.http\\.routers\\.(?<r>[^.]+)\\.rule$").r' <<<"$base"); do
    rule=$(label "$base" "$svc" "traefik.http.routers.$r.rule")
    rest=${rule//'PathPrefix(`/.well-known/oauth-protected-resource`)'/}
    case "$rest" in *well-known*) bad "router $r takes another /.well-known/ path: $rule" ;; esac
  done
done
[ "$(label "$base" web traefik.http.routers.dozo-app-noapi.rule)" = "$api_rule" ] ||
  bad "dozo-app-noapi does not take the same paths as dozo-api"

# Deploys without a gap (README): the proxy routes to a new api or web only once it answers, and
# probes it every second while it starts; bridge.sh takes a running one out of the proxy with the
# marker its check honours, within 30 seconds; the api gets the 30 seconds its shutdown expects; every
# router to a container retries a refused request (dozo-app-noapi answers nothing, dozo-api-closed
# only 403).
for svc in api web; do
  hc=$(jq -c --arg s "$svc" '.services[$s].healthcheck // {}' <<<"$base")
  [ "$(jq -r '.test | join(" ")' <<<"$hc" 2>/dev/null)" != "" ] || bad "$svc: no health check"
  [ "$(jq -r '.start_interval // empty' <<<"$hc")" = "1s" ] || bad "$svc: health check start_interval want 1s, got '$(jq -r '.start_interval // empty' <<<"$hc")'"
  [ -n "$(jq -r '.start_period // empty' <<<"$hc")" ] || bad "$svc: health check has no start_period"
  case "$(jq -r '.test | join(" ")' <<<"$hc" 2>/dev/null)" in
    "CMD-SHELL test ! -e /dev/shm/dozo-drain && "*) ;; *) bad "$svc: health check ignores /dev/shm/dozo-drain" ;;
  esac
  drain=$(jq -r '((.interval // "30s") | rtrimstr("s") | tonumber) * (.retries // 3)' <<<"$hc" 2>/dev/null)
  [ "${drain:-999}" -le 30 ] 2>/dev/null || bad "$svc: a marked container fails its check only after ${drain}s (interval x retries, want 30 or less)"
  retry="dozo-${svc/web/app}-retry"
  [ "$(label "$base" "$svc" "traefik.http.middlewares.$retry.retry.attempts")" -ge 2 ] 2>/dev/null || bad "$retry: want at least 2 attempts"
  for r in $(jq -r --arg s "$svc" '.services[$s].labels | keys[] | capture("^traefik\\.http\\.routers\\.(?<r>[^.]+)\\.rule$").r' <<<"$base"); do
    case "$r" in dozo-api-closed | dozo-app-noapi) continue ;; esac
    case ",$(label "$base" "$svc" "traefik.http.routers.$r.middlewares")," in
      *",$retry,"*) ;; *) bad "router $r does not use $retry" ;;
    esac
  done
done
[ "$(jq -r '.services.api.stop_grace_period // empty' <<<"$base")" = "30s" ] ||
  bad "api: stop_grace_period want 30s, got '$(jq -r '.services.api.stop_grace_period // empty' <<<"$base")'"

# bridge.sh's copy of a running api or web (built here from what Compose would give the container)
# keeps the proxy labels exactly, so the proxy merges it into the same service, and nothing that
# makes Compose or Docker treat it as part of the stack: no Compose label, no restart, no
# published port, no DNS alias. It keeps the environment and drains through its health check.
for svc in api web; do
  inspect=$(jq --arg s "$svc" '.services[$s] as $c | {
      Image: "sha256:test",
      Config: {Image: $c.image, Env: ["SECRET_KEY=a value\nwith a newline"], Cmd: $c.command,
        WorkingDir: $c.working_dir, User: "node",
        Labels: ($c.labels + {"com.docker.compose.project": "dozo", "com.docker.compose.service": $s})},
      HostConfig: {Memory: 1, RestartPolicy: {Name: "unless-stopped"},
        PortBindings: {"3100/tcp": [{HostIp: "127.0.0.1", HostPort: "3100"}]}},
      NetworkSettings: {Networks: {dozo: {Aliases: [$s]}, dozo_default: {Aliases: [$s]}}}
    }' <<<"$base")
  copy=$(bash "$REPO/dozo/deploy/bridge.sh" spec "$svc" <<<"$inspect") || { bad "bridge.sh spec $svc failed"; continue; }
  [ "$(jq -c '.Labels' <<<"$copy")" = "$(jq -c --arg s "$svc" '.services[$s].labels | with_entries(select(.key | startswith("traefik.")))' <<<"$base")" ] ||
    bad "bridge copy of $svc: proxy labels differ from the service's"
  [ "$(jq -r '.Labels | keys[] | select(startswith("traefik.") | not)' <<<"$copy")" = "" ] || bad "bridge copy of $svc keeps a non-proxy label"
  [ "$(jq -r '.HostConfig.RestartPolicy.Name' <<<"$copy")" = "no" ] || bad "bridge copy of $svc restarts"
  [ "$(jq -r '.HostConfig.PortBindings // "none"' <<<"$copy")" = "none" ] || bad "bridge copy of $svc publishes a port"
  [ "$(jq -c '[.NetworkingConfig.EndpointsConfig[] | .Aliases // empty] | add // []' <<<"$copy")" = "[]" ] || bad "bridge copy of $svc takes a DNS alias"
  [ "$(jq -c '.NetworkingConfig.EndpointsConfig | keys' <<<"$copy")" = '["dozo","dozo_default"]' ] || bad "bridge copy of $svc is not on the same networks"
  [ "$(jq -c '.Env' <<<"$copy")" = "$(jq -c '.Config.Env' <<<"$inspect")" ] || bad "bridge copy of $svc changes the environment"
  [ "$(jq -r '.Image' <<<"$copy")" = "sha256:test" ] || bad "bridge copy of $svc runs another image"
  case "$(jq -r '.Healthcheck.Test | join(" ")' <<<"$copy")" in
    "CMD-SHELL test ! -e /dev/shm/dozo-drain && "*) ;; *) bad "bridge copy of $svc does not drain through its health check" ;;
  esac
done

[ "$FAILED" = 0 ] && echo "[compose.test] ok"
exit "$FAILED"
