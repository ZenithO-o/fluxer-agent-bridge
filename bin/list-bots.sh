#!/bin/sh
# Status of every owner's bots (no secrets): sudo bin/list-bots.sh [owner]
. "$(dirname "$0")/_lib.sh"
grep -v '^\s*#' "$BB/owners.conf" | while read -r owner uid; do
  [ -n "${owner:-}" ] || continue
  [ -n "${1:-}" ] && [ "$1" != "$owner" ] && continue
  h=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PREFIX-$owner" 2>/dev/null || echo "missing")
  echo "== $PREFIX-$owner [$h]"
  docker exec "$PREFIX-$owner" node /app/dist/cli.js status 2>&1 | sed 's/^/   /'
done
