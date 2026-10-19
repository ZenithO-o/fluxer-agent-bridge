#!/bin/sh
# Reconnect drill: drop each bot's gateway socket without a close frame; expect RESUMED within ~2 s and no lost events.
set -eu
. "$(dirname "$0")/_lib.sh"
echo "${1:-}" | grep -Eq '^[a-z0-9_]+$' || { echo "usage: drill-reconnect.sh <owner>" >&2; exit 2; }
docker exec "$PREFIX-$1" kill -USR2 1 && sleep 5 && docker logs --since 10s "$PREFIX-$1" 2>&1 | grep -E 'DRILL|RESUMED|READY|closed'
