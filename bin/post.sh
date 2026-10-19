#!/bin/sh
# Post as a bot, using the token inside its container (the caller never holds it):
#   sudo bin/post.sh <owner> <bot> [--guild <id> | --dm] [--reply-to <message_id>] [--dry-run] <channel_id> <text...|->
# "-" reads the text from stdin. --guild dm equals --dm. With --guild/--dm it refuses (exit 3, nothing written) a channel
# outside that guild, a non-DM for --dm, or an unresolvable channel. No context = no check, unless the bot's bot.toml
# has require_guild = true (strict). Sends typing, then the message; prints the new message id.
set -eu
. "$(dirname "$0")/_lib.sh"
[ $# -ge 4 ] || { echo "usage: post.sh <owner> <bot> [--guild ID | --dm] [--reply-to ID] [--dry-run] <channel_id> <text...|->" >&2; exit 2; }
owner=$1; bot=$2; shift 2
echo "$owner" | grep -Eq '^[a-z0-9_]{1,32}$' || { echo "bad owner" >&2; exit 2; }
echo "$bot" | grep -Eq '^[a-z0-9_]{1,32}$' || { echo "bad bot" >&2; exit 2; }
exec docker exec -i "$PREFIX-$owner" node /app/dist/cli.js post "$bot" "$@"
