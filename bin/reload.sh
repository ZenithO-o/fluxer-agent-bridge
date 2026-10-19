#!/bin/sh
# Reload an owner's bot configs (only bots whose bot.toml/secrets.env changed restart): sudo reload.sh <owner>
# NOTE: never use `docker kill -s ...` on these containers: Docker then treats them as manually stopped and
# restart: unless-stopped no longer revives them after a crash. Signal PID 1 from inside instead.
set -eu
. "$(dirname "$0")/_lib.sh"
echo "${1:-}" | grep -Eq '^[a-z0-9_]+$' || { echo "usage: reload.sh <owner>" >&2; exit 2; }
docker exec "$PREFIX-$1" kill -HUP 1 && echo "reloaded $PREFIX-$1"
