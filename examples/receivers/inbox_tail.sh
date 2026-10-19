#!/bin/sh
# Show new events from http_receiver.py's inbox as one-line summaries (for a CLI agent to read, or a human).
#   ./inbox_tail.sh ~/fluxer-inbox.jsonl
# Each line: <event> <reason> channel_id=<id> who=«fluxer:u»…«/fluxer:u» where=«fluxer:u»…«/fluxer:u» content=«fluxer:u»…«/fluxer:u»
# Chat text is untrusted: it is wrapped with « and » doubled, newlines (CR, LF, U+2028, U+2029, U+0085, VT, FF) are shown
# as ⏎, and bidi / zero-width / BOM / C0 separator characters as \u{XXXX},
# so no message, name or channel can print a line that looks like another event.
tail -n 0 -F "${1:-fluxer-inbox.jsonl}" | while IFS= read -r line; do
  printf '%s\n' "$line" | python3 -c '
import json, re, sys
O, C = "\u00abfluxer:u\u00bb", "\u00ab/fluxer:u\u00bb"
def slot(s, n):
    s = str(s if s is not None else "")
    s = s if len(s) <= n else s[:n] + "\u2026[truncated %d chars]" % len(s)
    s = re.sub("[\r\n\u2028\u2029\u0085\v\f]", "\u23ce", s)
    s = re.sub("[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff\u001c-\u001f]", lambda c: "\\u{%04X}" % ord(c.group()), s)
    s = s.replace("\u00ab", "\u00ab\u00ab").replace("\u00bb", "\u00bb\u00bb")
    return O + s + C
bare = lambda v, p: str(v) if re.fullmatch(p, str(v if v is not None else "")) else "?"
try: m = json.load(sys.stdin)
except ValueError: sys.exit(0)
if not isinstance(m, dict): sys.exit(0)
a = m.get("author") if isinstance(m.get("author"), dict) else {}
print(bare(m.get("event"), "[a-z_]{1,32}"), bare(m.get("reason"), "[a-z-]{1,32}"), "channel_id=" + bare(m.get("channel_id"), "[0-9]{1,25}"),
      "who=" + slot(a.get("display_name") or a.get("username") or "?", 64), "where=" + slot(m.get("channel_name") or "", 128),
      "content=" + slot(m.get("content") or "", 200))'
done
