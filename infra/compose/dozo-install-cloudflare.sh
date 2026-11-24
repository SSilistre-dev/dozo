#!/usr/bin/env bash
# Optional step on top of install-images.sh: publish the stack through a Cloudflare Tunnel.
#
#   CLOUDFLARE_TUNNEL_TOKEN=<token> bash dozo-install-cloudflare.sh --hostname app.example.com
#
# Run it next to install-images.sh and dozo-docker-compose.cloudflare.yml. Any other flag goes to
# install-images.sh unchanged. Without this script the installer is what it always was.
# The token comes from the environment or a silent prompt, never from a flag (a flag shows in `ps`),
# is never printed, and is written only to .env (mode 600).
set -Eeuo pipefail

readonly ENV_FILE=".env"
readonly OVERRIDE_FILE="docker-compose.override.yml"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
readonly INSTALLER="$here/install-images.sh"
readonly OVERLAY="$here/dozo-docker-compose.cloudflare.yml"

temporary_file=""
trap '[[ -z "$temporary_file" ]] || rm -f -- "$temporary_file"' EXIT

fail() {
  echo "Tunnel setup failed: $*" >&2
  exit 1
}

hostname=""
installer_args=()
prepare_only=false
while (($#)); do
  case "$1" in
    --hostname)
      (($# >= 2)) || fail "--hostname needs a value."
      hostname="$2"
      shift 2
      ;;
    --hostname=*)
      hostname="${1#--hostname=}"
      shift
      ;;
    --prepare-only)
      prepare_only=true
      shift
      ;;
    *)
      installer_args+=("$1")
      shift
      ;;
  esac
done

# Text handling is pinned to the C locale per command: under tr_TR `tr` maps I to a dotless i and
# letter ranges skip i/I. The installer runs under it too (inline, so nothing else inherits it):
# its own sed ranges would otherwise drop every .env name containing i/I from its warning.
hostname="$(printf '%s' "$hostname" | LC_ALL=C tr 'A-Z' 'a-z')"
[[ -n "$hostname" ]] || fail "pass the public hostname: --hostname app.example.com"
matches() { # matches <value> <extended regex>, ranges read as ASCII whatever the caller's locale
  local LC_ALL=C
  [[ "$1" =~ $2 ]]
}
matches "$hostname" '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' ||
  fail "--hostname must be a bare hostname such as app.example.com (no scheme, port or path)."

# A name no caller is likely to export, with the export attribute stripped before the first
# assignment: a caller's exported variable of the same name would otherwise carry the secret into
# the environment of the installer, docker and openssl.
export -n tunnel_secret_value
tunnel_secret_value="${CLOUDFLARE_TUNNEL_TOKEN-}"
if [[ -z "$tunnel_secret_value" && -t 0 ]]; then
  read -r -s -p "Cloudflare tunnel token (hidden): " tunnel_secret_value
  echo
fi
[[ -n "$tunnel_secret_value" ]] || fail "set CLOUDFLARE_TUNNEL_TOKEN to the tunnel token."
matches "$tunnel_secret_value" '^[A-Za-z0-9+/=_-]+$' || fail "that is not a tunnel token."
unset CLOUDFLARE_TUNNEL_TOKEN

[[ -f "$INSTALLER" ]] || fail "install-images.sh must be next to this script."
[[ -f "$OVERLAY" ]] || fail "dozo-docker-compose.cloudflare.yml must be next to this script."

origin="https://${hostname}"
# Compose takes a shell value over .env, so a different one exported here would win and split the
# public origin between the tunnel and the app.
for key_value in "RAKAZO_HOST=$hostname" "BETTER_AUTH_URL=$origin" "WEB_ORIGIN=$origin" "API_URL=$origin"; do
  key="${key_value%%=*}"
  if [[ -n "${!key-}" && "${!key}" != "${key_value#*=}" ]]; then
    fail "${key} is set in the shell to another value; unset it."
  fi
done

if [[ -e "$OVERRIDE_FILE" ]] && ! cmp -s "$OVERLAY" "$OVERRIDE_FILE"; then
  fail "${OVERRIDE_FILE} already exists. Add the cloudflared service from $(basename "$OVERLAY") to it."
fi

# First pass: files and .env with random secrets, nothing started.
LC_ALL=C bash "$INSTALLER" ${installer_args[@]+"${installer_args[@]}"} --prepare-only

cp -- "$OVERLAY" "$OVERRIDE_FILE"

# The three public origins and the web host move together with the tunnel hostname (docs/self-host.md).
previous_umask="$(umask)"
umask 077
temporary_file=$(mktemp "./${ENV_FILE}.tmp.XXXXXX")
{
  LC_ALL=C grep -Ev '^[[:space:]]*(export[[:space:]]+)?(CLOUDFLARE_TUNNEL_TOKEN|RAKAZO_HOST|BETTER_AUTH_URL|WEB_ORIGIN|API_URL)[[:space:]]*=' "$ENV_FILE" || true
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$tunnel_secret_value"
  printf 'RAKAZO_HOST=%s\n' "$hostname"
  printf 'BETTER_AUTH_URL=%s\n' "$origin"
  printf 'WEB_ORIGIN=%s\n' "$origin"
  printf 'API_URL=%s\n' "$origin"
} >"$temporary_file"
chmod 600 "$temporary_file"
mv -- "$temporary_file" "$ENV_FILE"
temporary_file=""
umask "$previous_umask"
unset tunnel_secret_value
echo "Wrote the tunnel token and ${origin} to ${ENV_FILE}."

if [[ "$prepare_only" == true ]]; then
  echo "Files are ready. Run: bash install-images.sh"
  exit 0
fi

# Second pass: pull and start, now with the override and the tunnel settings in place.
LC_ALL=C bash "$INSTALLER" --local ${installer_args[@]+"${installer_args[@]}"}
echo "The app is reachable at ${origin} once the tunnel shows Healthy in the Cloudflare dashboard."
