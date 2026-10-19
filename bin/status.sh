#!/bin/sh
# Activity status control for the activity-status plugin (no secrets, no network listener):
#   sudo bin/status.sh <owner> <bot> responding <user_id|nick|-> [channel_id] [message_id] [issued_at_ms]
#   sudo bin/status.sh <owner> <bot> idle | show
# NICK resolution for responding: message_id's author > user_id > literal nick > last author in channel_id > last Reading author.
# issued_at_ms (epoch ms) lets the bridge drop a command that arrives after the reply already posted.
# Talks to the bot's loopback control endpoint via `docker exec` (never `docker kill`).
set -eu
. "$(dirname "$0")/_lib.sh"
usage() { echo "usage: status.sh <owner> <bot> responding <user_id|nick|-> [channel_id] [message_id] [issued_at_ms] | status.sh <owner> <bot> idle|show" >&2; exit 2; }
[ $# -ge 3 ] || usage
owner=$1; bot=$2; state=$3; target=${4:--}; chan=${5:-}; msg=${6:-}; at=${7:-}
echo "$owner" | grep -Eq '^[a-z0-9_]{1,32}$' || usage
echo "$bot" | grep -Eq '^[a-z0-9_]{1,32}$' || usage
case "$state" in responding|idle|show) ;; *) usage ;; esac
[ "$chan" = "-" ] && chan=""; [ "$msg" = "-" ] && msg=""; [ "$at" = "-" ] && at=""
for v in "$chan" "$msg" "$at"; do [ -z "$v" ] || echo "$v" | grep -Eq '^[0-9]{1,20}$' || usage; done
set -- node /app/dist/cli.js activity "$bot" "$state"
if [ "$state" = responding ]; then
  if echo "$target" | grep -Eq '^[0-9]{15,20}$'; then set -- "$@" --user "$target"
  elif [ "$target" != "-" ]; then
    nick=$(printf '%s' "$target" | tr -d '\000-\037' | cut -c1-64)
    set -- "$@" --nick "$nick"
  fi
  [ -z "$chan" ] || set -- "$@" --channel "$chan"
  [ -z "$msg" ] || set -- "$@" --message "$msg"
  [ -z "$at" ] || set -- "$@" --at "$at"
fi
exec timeout 10 docker exec "$PREFIX-$owner" "$@"
