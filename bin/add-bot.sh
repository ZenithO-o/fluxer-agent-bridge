#!/bin/sh
# Add or update a bot. Secrets come ONLY on stdin as KEY=VALUE lines and are never echoed.
#   printf 'FLUXER_BOT_TOKEN=%s\nWEBHOOK_URL=%s\nWEBHOOK_AUTH=%s\n' "$TOK" "$URL" "Bearer $KEY" \
#     | ssh your-host 'sudo /path/to/fluxer-agent-bridge/bin/add-bot.sh <owner> <bot>'
# Allowed keys: FLUXER_BOT_TOKEN WEBHOOK_URL WEBHOOK_AUTH WEBHOOK_KEY (legacy). Existing keys not sent are kept.
# Send nothing on stdin (</dev/null) to only (re)create bot.toml / reload.
# A new owner gets the next free uid (10001+), a compose service, and its container started.
set -eu
umask 077
. "$(dirname "$0")/_lib.sh"
owner=${1:-}; bot=${2:-}
echo "$owner" | grep -Eq '^[a-z0-9_]{1,32}$' || { echo "usage: add-bot.sh <owner> <bot>  (lowercase [a-z0-9_])" >&2; exit 2; }
echo "$bot"   | grep -Eq '^[a-z0-9_]{1,32}$' || { echo "usage: add-bot.sh <owner> <bot>  (lowercase [a-z0-9_])" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
need_instance
touch "$BB/owners.conf"

uid=$(awk -v o="$owner" '$1==o{print $2}' "$BB/owners.conf")
new_owner=0
if [ -z "$uid" ]; then
  uid=$(awk '!/^#/ && $2>m{m=$2} END{print (m?m+1:10001)}' "$BB/owners.conf")
  printf '%s %s\n' "$owner" "$uid" >> "$BB/owners.conf"; new_owner=1
  "$BB/bin/render-compose.sh"
  echo "new owner $owner (uid $uid)"
fi
d=$BB/owners/$owner/$bot
install -d -m 700 -o "$uid" -g "$uid" "$BB/owners/$owner" "$d" "$BB/state/$owner"
[ -f "$d/bot.toml" ] || { install -m 640 -o "$uid" -g "$uid" "$BB/templates/bot.toml" "$d/bot.toml"; echo "created $d/bot.toml from template (edit plugins/mode there)"; }

tmp=$(mktemp "$d/.secrets.XXXXXX")
[ -f "$d/secrets.env" ] && cat "$d/secrets.env" > "$tmp"
n=0
if [ ! -t 0 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue;; esac
    k=${line%%=*}; v=${line#*=}
    case "$k" in FLUXER_BOT_TOKEN|WEBHOOK_URL|WEBHOOK_AUTH|WEBHOOK_KEY) ;; *) echo "ignored unknown key: $k" >&2; continue;; esac
    grep -v "^$k=" "$tmp" > "$tmp.2" || true; mv "$tmp.2" "$tmp"
    printf '%s=%s\n' "$k" "$v" >> "$tmp"; n=$((n+1)); echo "set $k (${#v} chars)"
  done
fi
if [ -f "$d/secrets.env" ] && cmp -s "$tmp" "$d/secrets.env"; then rm -f "$tmp"
else
  if [ -f "$d/secrets.env" ]; then install -d -m 700 "$BB/backup"; cp -p "$d/secrets.env" "$BB/backup/$owner.$bot.secrets.$(date +%Y%m%d-%H%M%S)"; fi
  chown "$uid:$uid" "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$d/secrets.env"
fi

# verify the token without printing it (curl reads the header from stdin, not argv)
tok=$(sed -n 's/^FLUXER_BOT_TOKEN=//p' "$d/secrets.env" | tail -1)
if [ -n "$tok" ]; then
  me=$(printf 'header = "Authorization: Bot %s"\n' "$tok" | curl -sS -m 10 -K - "$FLUXER_INSTANCE/api/v1/users/@me" || true)
  echo "$me" | grep -q '"bot":true' && echo "token OK: $(echo "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p') ($(echo "$me" | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p'))" \
    || echo "WARNING: token check failed (not a valid bot token?)" >&2
else echo "no FLUXER_BOT_TOKEN yet" >&2; fi
unset tok me

cd "$BB"
if [ "$new_owner" = 1 ] || ! docker ps --format '{{.Names}}' | grep -qx "$PREFIX-$owner"; then
  docker compose up -d "$PREFIX-$owner"
else
  docker exec "$PREFIX-$owner" kill -HUP 1 && echo "reloaded $PREFIX-$owner (only changed bots restart)"
fi
