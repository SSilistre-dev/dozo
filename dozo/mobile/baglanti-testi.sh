#!/usr/bin/env bash
# Mobile connection self-test: makes the requests the mobile app makes, in its order and with its
# headers, against one server, and prints a pass/fail table.
# Usage: baglanti-testi.sh <server url>. Exit 0 all passed (a missing association file is only a
# warning), 2 any failure, 64 usage. Needs curl and jq. Signs up a throwaway account and deletes
# it at the end; skips the account steps when the server's sign-up is closed.
set -uo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <server url>" >&2; exit 64; }
if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then echo "FAIL: needs curl and jq" >&2; exit 2; fi

# The app's own address handling: https when no scheme, only scheme and host kept.
url=$(printf '%s' "$1" | tr -d '[:space:]')
case "$url" in http://* | https://*) ;; *) url="https://$url" ;; esac
url=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')

STREAM_SECONDS="${DOZO_STREAM_SECONDS:-60}"
ORIGIN="rakazo://"
work=$(mktemp -d "${TMPDIR:-/tmp}/dozo-baglanti-XXXXXX")
token="" email="" password="" deleted=0 fails=0 warns=0
rows=()

row() { # status, step, detail
  rows+=("$(printf '%-5s | %-26s | %s' "$1" "$2" "$3")")
  case "$1" in FAIL) fails=$((fails + 1)) ;; WARN) warns=$((warns + 1)) ;; esac
}

# request <name> <curl args...>: body in $work/<name>.body, headers in $work/<name>.head; prints the status.
request() {
  local name=$1; shift
  curl -sS --max-time 15 -o "$work/$name.body" -D "$work/$name.head" -w '%{http_code}' \
    -H "origin: $ORIGIN" "$@" 2>"$work/$name.err" || true
}
header() { grep -i "^$2:" "$work/$1.head" 2>/dev/null | tail -1 | cut -d' ' -f2- | tr -d '\r'; }
reason() { [ -s "$work/$1.err" ] && head -c 120 "$work/$1.err" | tr '\n' ' ' || echo "HTTP $2"; }

cleanup() {
  if [ -n "$token" ] && [ "$deleted" -eq 0 ]; then
    curl -sS --max-time 15 -o /dev/null -H "origin: $ORIGIN" -H "authorization: Bearer $token" \
      -H 'content-type: application/json' -d "$(jq -nc --arg p "$password" '{password:$p}')" \
      "$url/api/auth/delete-user" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# 1. What the sign-in screen reads first.
code=$(request caps "$url/api/auth/capabilities")
if [ "$code" = 200 ] && jq -e '.passwordAuth | type == "boolean"' "$work/caps.body" >/dev/null 2>&1; then
  signups=$(jq -r 'if .signupsOpen == false then "closed" else "open" end' "$work/caps.body")
  row PASS "capabilities" "200, sign-up $signups, passkeys ios=$(jq -r '.nativePasskeys.ios // false' "$work/caps.body") android=$(jq -r '.nativePasskeys.android // false' "$work/caps.body")"
else
  signups=unknown
  [ -s "$work/caps.err" ] && why=$(reason caps "$code") || why="$(reason caps "$code"), not a Dozo server's answer"
  row FAIL "capabilities" "$why"
fi

# 2. The Server screen's health check.
code=$(request health -X POST -H 'content-type: application/json' -d '{"json":{}}' "$url/rpc/health")
if [ "$code" = 200 ] && jq -e '.json.ok == true' "$work/health.body" >/dev/null 2>&1; then
  row PASS "health" "200"
else
  row FAIL "health" "$(reason health "$code")"
fi

# 3. The live stream's CORS preflight, as a WebView or a strict client sends it.
code=$(request preflight -X OPTIONS -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: authorization,content-type' "$url/rpc/notifications/subscribe")
allow=$(header preflight access-control-allow-origin)
if [ "${code:0:1}" = 2 ] && [ "$allow" = "$ORIGIN" ]; then
  row PASS "CORS preflight" "$code, allow-origin $allow"
else
  row FAIL "CORS preflight" "$(reason preflight "$code"), allow-origin '${allow}'"
fi

# 4-6. Sign-up, sign-in and the session, by bearer token and without cookies.
if [ "$signups" = open ]; then
  email="mobile-check-$(date +%s)-$RANDOM@example.com"
  password="Mc-$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  body=$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p,name:"Mobile check"}')
  code=$(request signup -H 'content-type: application/json' -d "$body" "$url/api/auth/sign-up/email")
  token=$(header signup set-auth-token)
  [ -n "$token" ] || token=$(jq -r '.token // empty' "$work/signup.body" 2>/dev/null)
  if [ "$code" = 200 ] && [ -n "$token" ]; then row PASS "sign-up" "200, token received"
  else row FAIL "sign-up" "$(reason signup "$code"), $(jq -r '.code // .message // "no token"' "$work/signup.body" 2>/dev/null)"; fi

  code=$(request signin -H 'content-type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p}')" "$url/api/auth/sign-in/email")
  signin=$(header signin set-auth-token)
  [ -n "$signin" ] || signin=$(jq -r '.token // empty' "$work/signin.body" 2>/dev/null)
  if [ "$code" = 200 ] && [ -n "$signin" ]; then row PASS "sign-in" "200, token received"; token=$signin
  else row FAIL "sign-in" "$(reason signin "$code")"; fi

  if [ -n "$token" ]; then
    code=$(request session -H "authorization: Bearer $token" "$url/api/auth/get-session")
    if [ "$code" = 200 ] && [ "$(jq -r '.user.email // empty' "$work/session.body" 2>/dev/null)" = "$email" ]; then
      row PASS "session (bearer)" "200, the account's own"
    else row FAIL "session (bearer)" "$(reason session "$code")"; fi
  fi
else
  row SKIP "sign-up, sign-in, session" "sign-up is $signups on this server"
fi

# 7. The one live stream, held as long as the app holds it between reconnects.
if [ -n "$token" ]; then
  start=$(date +%s)
  curl -sS -N --max-time "$STREAM_SECONDS" -o "$work/stream.body" -D "$work/stream.head" \
    -X POST -H "origin: $ORIGIN" -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -H 'accept: text/event-stream' -d '{"json":{}}' "$url/rpc/notifications/subscribe" 2>"$work/stream.err"
  rc=$? held=$(($(date +%s) - start))
  status=$(head -1 "$work/stream.head" 2>/dev/null | awk '{print $2}')
  frames=$(grep -c '^data:' "$work/stream.body" 2>/dev/null) || frames=0
  beats=$(grep -c '"heartbeat"' "$work/stream.body" 2>/dev/null) || beats=0
  # curl ends a healthy stream itself at the time limit (exit 28); anything earlier is a drop.
  if [ "$status" = 200 ] && [ "$rc" -eq 28 ] && [ "$held" -ge $((STREAM_SECONDS - 1)) ] && [ "$beats" -ge 1 ]; then
    row PASS "live stream ${STREAM_SECONDS}s" "held ${held}s, $frames frames, $beats heartbeats"
  else
    row FAIL "live stream ${STREAM_SECONDS}s" "HTTP ${status:-none}, curl exit $rc after ${held}s, $frames frames, $beats heartbeats"
  fi
else
  row SKIP "live stream" "no session"
fi

# 8. The association files passkeys need; missing until the deployment names its apps.
for file in apple-app-site-association assetlinks.json; do
  code=$(request "$file" "$url/.well-known/$file")
  if [ "$code" = 200 ] && jq -e . "$work/$file.body" >/dev/null 2>&1; then
    row PASS "$file" "200, $(jq -c . "$work/$file.body" | head -c 90)"
  elif [ "$code" = 404 ]; then
    row WARN "$file" "404: the deployment names no app yet (dozo/deploy/README.md, Mobile app ids)"
  else
    row FAIL "$file" "$(reason "$file" "$code")"
  fi
done

# 9. Delete the throwaway account, then make sure it is gone.
if [ -n "$token" ]; then
  code=$(request delete -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "$(jq -nc --arg p "$password" '{password:$p}')" "$url/api/auth/delete-user")
  again=$(request gone -H 'content-type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p}')" "$url/api/auth/sign-in/email")
  if [ "$code" = 200 ] && [ "$again" = 401 ]; then deleted=1; row PASS "delete test account" "200, sign-in now 401"
  else row FAIL "delete test account" "delete HTTP $code, sign-in after it HTTP $again"; fi
fi

echo "server: $url"
printf '%s\n' "${rows[@]}"
if [ "$fails" -gt 0 ]; then echo "BAGLANTI: FAIL ($fails failed, $warns warnings)"; exit 2; fi
echo "BAGLANTI: PASS ($warns warnings)"
