#!/usr/bin/env bash
# dozo-install-cloudflare.sh: the opt-in tunnel step. Offline; docker is a stub except for the last
# block, which runs `docker compose config` on the overlay (needs docker and jq, no daemon).
# Run by `gate.sh olc` and by run-smokes.sh. Exit 0 all pass, 1 a case failed.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
token_secret="eyJhIjoidGVzdC10dW5uZWwtdG9rZW4i"

bash -n "$root/dozo-install-cloudflare.sh" || fail "bash -n"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/dozo-cloudflare-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
# Stub: `config --environment` echoes the .env the installer validates; every call is logged.
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${STUB_DOCKER_LOG:?}"
env >> "${STUB_ENV_LOG:?}"
for a in "$@"; do
  if [[ "$a" == config ]]; then
    cat >/dev/null
    grep -E '^[A-Z_]+=' .env
    exit 0
  fi
done
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/curl"
chmod +x "$tmp/bin/docker" "$tmp/bin/curl"

new_cwd() { # a fresh install folder: the installer, its files and the tunnel files
  rm -rf "$tmp/cwd"; mkdir -p "$tmp/cwd"
  cp "$root/install-images.sh" "$root/docker-compose.images.yml" "$root/.env.images.example" \
    "$root/dozo-install-cloudflare.sh" "$root/dozo-docker-compose.cloudflare.yml" "$tmp/cwd/"
  : > "$tmp/docker.log"; : > "$tmp/env.log"
}
run() { # args... ; env passes through; exit status and output in $code and $out
  set +e
  out="$(cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" STUB_DOCKER_LOG="$tmp/docker.log" STUB_ENV_LOG="$tmp/env.log" SANDBOX_COMPUTER_EGRESS=open \
    bash dozo-install-cloudflare.sh "$@" 2>&1 </dev/null)"
  code=$?
  set -e
}

# Refusals touch nothing.
new_cwd
run --local --prepare-only
[[ $code -eq 1 && "$out" == *"--hostname"* ]] || fail "no hostname: want exit 1, got $code"
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname https://app.example.com --local
[[ $code -eq 1 ]] || fail "hostname with a scheme was accepted"
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname app.example.com/x --local
[[ $code -eq 1 ]] || fail "hostname with a path was accepted"
run --hostname app.example.com --local
[[ $code -eq 1 && "$out" == *CLOUDFLARE_TUNNEL_TOKEN* ]] || fail "no token: want exit 1, got $code"
CLOUDFLARE_TUNNEL_TOKEN='bad token;rm' run --hostname app.example.com --local
[[ $code -eq 1 ]] || fail "a token with spaces was accepted"
[[ ! -e "$tmp/cwd/.env" && ! -e "$tmp/cwd/docker-compose.override.yml" ]] || fail "a refusal wrote files"
CLOUDFLARE_TUNNEL_TOKEN=$token_secret BETTER_AUTH_URL=https://other.example run --hostname app.example.com --local
[[ $code -eq 1 && "$out" == *BETTER_AUTH_URL* ]] || fail "a conflicting shell origin was accepted"
echo "operator override" > "$tmp/cwd/docker-compose.override.yml"
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname app.example.com --local
[[ $code -eq 1 && "$out" == *docker-compose.override.yml* ]] || fail "an existing override was replaced or ignored"
[[ "$(cat "$tmp/cwd/docker-compose.override.yml")" == "operator override" ]] || fail "the operator's override was changed"

# --prepare-only: .env and the overlay, nothing started; the token is only in .env.
new_cwd
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname App.Example.com --local --prepare-only
[[ $code -eq 0 ]] || fail "prepare-only: exit $code: $out"
[[ "$out" != *"$token_secret"* ]] || fail "the token was printed"
cmp -s "$root/dozo-docker-compose.cloudflare.yml" "$tmp/cwd/docker-compose.override.yml" || fail "overlay not installed"
env_file="$tmp/cwd/.env"
for line in "CLOUDFLARE_TUNNEL_TOKEN=$token_secret" RAKAZO_HOST=app.example.com \
  BETTER_AUTH_URL=https://app.example.com WEB_ORIGIN=https://app.example.com API_URL=https://app.example.com; do
  [[ "$(grep -cxF -- "$line" "$env_file")" -eq 1 ]] || fail ".env lacks exactly one '${line%%=*}'"
done
[[ "$(grep -c '^POSTGRES_PASSWORD=.' "$env_file")" -eq 1 ]] || fail "the installer's secrets are gone"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; } # GNU first: on Linux `stat -f` is filesystem status and exits 0
[[ "$(mode "$env_file")" == 600 ]] || fail ".env is not mode 600"
grep -rlF -- "$token_secret" "$tmp/cwd" | grep -vxF "$env_file" && fail "the token is written outside .env" || true
! grep -q -- "$token_secret" "$tmp/docker.log" || fail "the token reached a docker argument"
! grep -qE ' up( |$)' "$tmp/docker.log" || fail "prepare-only started the stack"

# A rerun with another hostname replaces the values, keeps one of each and the same secrets.
secret_before="$(grep '^POSTGRES_PASSWORD=' "$env_file")"
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname chat.example.org --local --prepare-only
[[ $code -eq 0 ]] || fail "rerun: exit $code: $out"
[[ "$(grep -c '^BETTER_AUTH_URL=' "$env_file")" -eq 1 && "$(grep -c '^RAKAZO_HOST=' "$env_file")" -eq 1 ]] || fail "rerun duplicated a key"
grep -qx 'WEB_ORIGIN=https://chat.example.org' "$env_file" || fail "rerun kept the old origin"
[[ "$(grep '^POSTGRES_PASSWORD=' "$env_file")" == "$secret_before" ]] || fail "rerun changed a secret"

# Full run: the second installer pass starts the stack with the override layered in.
new_cwd
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname app.example.com --local
[[ $code -eq 0 ]] || fail "full run: exit $code: $out"
[[ "$out" != *"$token_secret"* ]] || fail "the token was printed"
grep -E ' up( |$)' "$tmp/docker.log" | grep -q 'docker-compose.override.yml' || fail "up did not use the override"
[[ "$(mode "$tmp/cwd/.env")" == 600 ]] || fail ".env is not mode 600 after the full run"

# A variable the caller already exports, under the wrapper's old name or its current one, must not
# carry the secret into the environment of docker or of the installer (real and stub installer).
new_cwd
export token=caller-value tunnel_secret_value=caller-value
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname app.example.com --local
unset token tunnel_secret_value
[[ $code -eq 0 ]] || fail "exported-name run: exit $code: $out"
[[ -s "$tmp/env.log" ]] || fail "the docker stub saw no environment"
! grep -qF -- "$token_secret" "$tmp/env.log" || fail "the token reached the environment of docker"
rm -rf "$tmp/cwd"; mkdir -p "$tmp/cwd"
cp "$root/dozo-install-cloudflare.sh" "$root/dozo-docker-compose.cloudflare.yml" "$tmp/cwd/"
cat > "$tmp/cwd/install-images.sh" <<'STUB'
#!/usr/bin/env bash
env >> "${STUB_ENV_LOG:?}"
[ -e .env ] || : > .env
case " $* " in *" --prepare-only "*) ;; *) : > second-pass-file ;; esac
STUB
: > "$tmp/env.log"
export token=caller-value tunnel_secret_value=caller-value
CLOUDFLARE_TUNNEL_TOKEN=$token_secret run --hostname app.example.com --local
unset token tunnel_secret_value
[[ $code -eq 0 ]] || fail "stub installer run: exit $code: $out"
[[ -s "$tmp/env.log" ]] || fail "the installer stub saw no environment"
! grep -qF -- "$token_secret" "$tmp/env.log" || fail "the token reached the environment of the installer"
# umask 077 applies to the .env rewrite only: the second pass creates files with the caller's umask.
want_mode="$(printf '%o' $((0666 & ~0$(umask))))" # what `: >` creates under this shell's umask
[[ "$(mode "$tmp/cwd/second-pass-file")" == "$want_mode" ]] || fail "the installer's second pass did not get the caller's umask (want $want_mode)"
[[ "$(mode "$tmp/cwd/.env")" == 600 ]] || fail ".env is not mode 600 (stub installer)"

# The default install is untouched: the installer without this script writes no tunnel setting.
new_cwd
(cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" STUB_DOCKER_LOG="$tmp/docker.log" STUB_ENV_LOG="$tmp/env.log" SANDBOX_COMPUTER_EGRESS=open \
  bash install-images.sh --local --prepare-only >/dev/null 2>&1)
[[ ! -e "$tmp/cwd/docker-compose.override.yml" ]] || fail "the plain installer wrote an override"
! grep -q CLOUDFLARE "$tmp/cwd/.env" || fail "the plain installer wrote a tunnel setting"

# The overlay against the real Compose file: one extra service, no ports, web is its only
# dependency, and the token must be set.
command -v docker >/dev/null 2>&1 || fail "docker is required to check the overlay"
command -v jq >/dev/null 2>&1 || fail "jq is required to check the overlay"
cfg() {
  env -i PATH="$PATH" HOME="${HOME:-/tmp}" DOCKER_CONFIG="${DOCKER_CONFIG:-${HOME:-/tmp}/.docker}" \
    POSTGRES_PASSWORD=x POSTGRES_APP_PASSWORD=x SANDBOX_SUPERVISOR_TOKEN=x SCREEN_PROXY_SECRET=x "$@" \
    docker compose --env-file /dev/null -f "$root/docker-compose.images.yml" ${files[@]+"${files[@]}"} config --format json
}
files=(-f "$root/dozo-docker-compose.cloudflare.yml")
if cfg >/dev/null 2>&1; then fail "the overlay validates without a token"; fi
with=$(cfg CLOUDFLARE_TUNNEL_TOKEN=$token_secret) || fail "docker compose config (overlay)"
files=()
without=$(cfg) || fail "docker compose config (base)"
[[ "$(jq -r '.services.cloudflared.ports // [] | length' <<<"$with")" -eq 0 ]] || fail "cloudflared publishes a port"
[[ "$(jq -r '.services.cloudflared.depends_on | keys | join(",")' <<<"$with")" == web ]] || fail "cloudflared must depend on web only"
[[ "$(jq -r '.services.cloudflared.networks | keys | join(",")' <<<"$with")" == app ]] || fail "cloudflared must be on the app network only"
[[ "$(jq -r '.services.cloudflared.environment.TUNNEL_TOKEN' <<<"$with")" == "$token_secret" ]] || fail "the token does not reach cloudflared"
[[ "$(jq -r '.services.cloudflared.image' <<<"$with")" =~ ^cloudflare/cloudflared:[0-9]{4}\.[0-9]+\.[0-9]+$ ]] || fail "image is not a pinned tag"
[[ "$(jq -r '.services.cloudflared.restart' <<<"$with")" == "$(jq -r '.services.web.restart' <<<"$with")" ]] || fail "restart policy differs from web"
[[ "$(jq -S '.services | del(.cloudflared)' <<<"$with")" == "$(jq -S '.services' <<<"$without")" ]] || fail "the overlay changed another service"
echo "dozo-install-cloudflare smoke: ok"
