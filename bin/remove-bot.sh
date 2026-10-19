#!/bin/sh
# Remove a bot (its files move to backup/, root-only): sudo remove-bot.sh <owner> <bot>
set -eu
. "$(dirname "$0")/_lib.sh"; owner=${1:-}; bot=${2:-}
echo "$owner$bot" | grep -Eq '^[a-z0-9_]+$' && [ -d "$BB/owners/$owner/$bot" ] || { echo "no such bot" >&2; exit 2; }
install -d -m 700 "$BB/backup"; mv "$BB/owners/$owner/$bot" "$BB/backup/$owner.$bot.removed.$(date +%Y%m%d-%H%M%S)"
docker exec "$PREFIX-$owner" kill -HUP 1 && echo "removed $owner/$bot and reloaded"
