#!/bin/sh
# Rotate/update secrets for an existing bot: send only the changed KEY=VALUE lines on stdin.
exec "$(dirname "$0")/add-bot.sh" "$@"
