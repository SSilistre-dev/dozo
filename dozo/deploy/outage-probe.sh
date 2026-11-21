#!/usr/bin/env bash
# Watches the app from outside while a deploy runs, the way a user's open tab would reach it: the
# API (POST /rpc/health), the page (GET /), a live stream (the notifications subscription) and the
# device socket (a WebSocket upgrade). Neither asks to sign in, so the stream and the socket count
# as up when the API itself answers them (401), and as down on anything the proxy answers instead
# (502, 503, 404) or no answer in time. Runs until it gets SIGTERM or its parent exits,
# then prints what each target saw, with its slowest answer (a request the proxy had to send again
# arrives late but arrives), and last `[probe] longest outage <seconds>s (<target>)`.
# Usage: outage-probe.sh <base url> <raw log file> [extra curl arguments...]
# DOZO_PROBE_INTERVAL (seconds, default 2, so about two requests a second in all) is the pause
# between two requests of one target and
# DOZO_PROBE_TIMEOUT (seconds, default 10) how long one may take.
set -uo pipefail
export LC_ALL=C

[ $# -ge 2 ] || {
  echo "usage: outage-probe.sh <base url> <raw log file> [curl arguments...]" >&2
  exit 64
}
base=${1%/} log=$2
shift 2
extra=("$@")
interval=${DOZO_PROBE_INTERVAL:-2} timeout=${DOZO_PROBE_TIMEOUT:-10}
parent=$PPID
: >"$log"

now() { printf '%s' "${EPOCHREALTIME:-$(date +%s)}"; }

# probe <target> <codes that mean up> <curl arguments...>: one line per request into the log.
probe() {
  local target=$1 up=$2 start code took
  shift 2
  while kill -0 "$parent" 2>/dev/null; do
    start=$(now)
    read -r code took < <(curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' -m "$timeout" \
      ${extra[@]+"${extra[@]}"} "$@" 2>/dev/null || true)
    case " $up " in
      *" ${code:-000} "*) echo "$target $start up ${code:-000} ${took:-$timeout}" ;;
      *) echo "$target $start down ${code:-000} ${took:-$timeout}" ;;
    esac >>"$log"
    sleep "$interval"
  done
}

summary() {
  # An outage runs from the first failed request to the next one that got through, or to the end
  # of the last request when none did.
  awk '
    { t = $1; at = $2 + 0; n[t]++; last[t] = at + $5; if ($5 > slow[t]) slow[t] = $5
      if ($3 == "down") { failed[t]++; if (!(t in from)) from[t] = at; codes[t, $4]++ }
      else if (t in from) { gap = at - from[t]; if (gap > worst[t]) worst[t] = gap; delete from[t] } }
    END {
      top = 0; name = "none"
      for (t in n) {
        if (t in from) { gap = last[t] - from[t]; if (gap > worst[t]) worst[t] = gap }
        seen = ""
        for (k in codes) { split(k, p, SUBSEP); if (p[1] == t) seen = seen " " p[2] "x" codes[k] }
        printf "[probe] %-6s %5d requests %4d failed  longest outage %.1fs  slowest %.1fs%s\n", t, n[t], failed[t], worst[t], slow[t], (seen == "" ? "" : "  (" substr(seen, 2) ")")
        if (worst[t] > top) { top = worst[t]; name = t }
      }
      printf "[probe] longest outage %.1fs (%s)\n", top, name
    }' "$log"
}

json=(-H 'content-type: application/json' --data '{}')
probe api "200" -X POST "${json[@]}" "$base/rpc/health" &
probe web "200" "$base/" &
probe stream "200 401" -X POST -H 'accept: text/event-stream' "${json[@]}" "$base/rpc/notifications/subscribe" &
probe socket "101 401" --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: ZG96by1kZXBsb3ktcHJvYmU=' "$base/api/devices/connect" &

finish() {
  trap - TERM INT
  kill $(jobs -p) 2>/dev/null
  wait 2>/dev/null
  summary
  exit 0
}
trap finish TERM INT
while kill -0 "$parent" 2>/dev/null; do sleep 1 & wait $!; done
finish
