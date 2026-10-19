#!/bin/sh
# POST one synthetic, clearly-labelled test batch (test:true, "fluxer-agent-bridge test, please ignore") to a bot's webhook.
# Nothing is posted into Fluxer. Usage: sudo test-webhook.sh <owner> <bot>
set -eu
. "$(dirname "$0")/_lib.sh"
echo "${1:-}${2:-}" | grep -Eq '^[a-z0-9_]+$' || { echo "usage: test-webhook.sh <owner> <bot>" >&2; exit 2; }
exec docker exec "$PREFIX-$1" node /app/dist/cli.js test-webhook "$2"
