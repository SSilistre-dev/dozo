#!/usr/bin/env bash
# Revokes every channel the relay agent of a server folder holds, paired or still pairing, with
# the agent that server installed: the relay deletes each one. What the canary
# (tests/stack_e2e_native.sh --relay) runs at its end, and the workflow again whatever happened.
# Nothing to do when the folder has no agent or no channel.
# Usage: relay_revoke.sh <server folder>   Needs Node 24. Exit 0 done, 2 a revoke failed, 64 usage.
set -uo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <server folder>" >&2; exit 64; }
state="$1/relay"
agent=$(find "$1/versions" -name dozo-relay-agent.mjs 2> /dev/null | head -n 1)
[ -n "$agent" ] && [ -d "$state" ] || { echo "[revoke] no relay agent state in $1"; exit 0; }
channels=$(node "$agent" list --state "$state" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const c of JSON.parse(s).channels)console.log(c.channel)})') \
  || { echo "[revoke] FAILED: could not list the channels"; exit 2; }
rc=0
for channel in $channels; do
  node "$agent" revoke "$channel" --state "$state" || rc=2
done
echo "[revoke] left: $(node "$agent" list --state "$state")"
exit $rc
