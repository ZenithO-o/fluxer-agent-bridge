#!/bin/sh
# Show new events from http_receiver.py's inbox as one-line summaries (for a CLI agent to read, or a human).
#   ./inbox_tail.sh ~/fluxer-inbox.jsonl
# Each line: <event> <reason> #<channel> <author>: <content>
tail -n 0 -F "${1:-fluxer-inbox.jsonl}" | while IFS= read -r line; do
  printf '%s\n' "$line" | python3 -c 'import json,sys; m=json.load(sys.stdin); a=m.get("author") or {}; print(m.get("event"), m.get("reason"), "#"+str(m.get("channel_name")), (a.get("display_name") or a.get("username") or "?")+":", (m.get("content") or "")[:200])'
done
