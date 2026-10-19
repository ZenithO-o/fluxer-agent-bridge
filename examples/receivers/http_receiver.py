#!/usr/bin/env python3
"""http_receiver.py: tiny webhook receiver for fluxer-agent-bridge (stdlib only).

Accepts the bridge's POSTs, checks the Authorization header, de-duplicates by Idempotency-Key, and for each batch:
  * appends one JSON line per event to an inbox file (--inbox, default ./fluxer-inbox.jsonl), and/or
  * runs a command (--exec) with the batch JSON on stdin (e.g. a CLI agent: `claude -p ...`, a script, a queue push).
Always answers 2xx once the batch is safely stored, so the bridge does not retry; a failing --exec does not lose data.

  WEBHOOK_TOKEN=secret ./http_receiver.py --port 8787 --inbox ~/fluxer-inbox.jsonl
  WEBHOOK_TOKEN=secret ./http_receiver.py --exec './handle-batch.sh'

Bridge side (secrets.env): WEBHOOK_URL=http://<this-host>:8787/fluxer   WEBHOOK_AUTH=Bearer secret
Put it behind TLS (reverse proxy / tailnet) if it is not on the same private network as the bridge.
"""
import argparse, hmac, json, os, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

seen, seen_lock = [], threading.Lock()

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--path", default="/fluxer"); ap.add_argument("--inbox", default="fluxer-inbox.jsonl")
    ap.add_argument("--exec", dest="cmd", default=None, help="shell command run per batch, batch JSON on stdin")
    ap.add_argument("--skip-test", action="store_true", help="drop synthetic test batches (test:true)")
    a = ap.parse_args()
    token = os.environ.get("WEBHOOK_TOKEN", "")
    if not token: print("warning: WEBHOOK_TOKEN not set, accepting unauthenticated POSTs", file=sys.stderr)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def _send(self, code, obj):
            b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_POST(self):
            if self.path.split("?")[0] != a.path: return self._send(404, {"error": "not found"})
            if token and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
                return self._send(401, {"error": "unauthorized"})
            n = int(self.headers.get("Content-Length") or 0)
            if n > 8 * 1024 * 1024: return self._send(413, {"error": "too large"})
            try: batch = json.loads(self.rfile.read(n) or b"{}")
            except ValueError: return self._send(400, {"error": "bad json"})
            key = self.headers.get("Idempotency-Key", "")
            with seen_lock:
                if key and key in seen: return self._send(200, {"ok": True, "duplicate": True})
                if key: seen.append(key); del seen[:-1000]
            if a.skip_test and batch.get("test"): return self._send(200, {"ok": True, "skipped": "test"})
            with open(os.path.expanduser(a.inbox), "a") as f:
                for m in batch.get("messages", []):
                    f.write(json.dumps({"received_at": time.time(), "bot": batch.get("bot"), "owner": batch.get("owner"), **m}) + "\n")
            if a.cmd:
                try: subprocess.Popen(a.cmd, shell=True, stdin=subprocess.PIPE, start_new_session=True).communicate(json.dumps(batch).encode(), timeout=1)
                except subprocess.TimeoutExpired: pass  # keep running in the background
                except Exception as e: print(f"exec failed: {e}", file=sys.stderr)
            self._send(200, {"ok": True, "stored": len(batch.get("messages", []))})

    print(f"listening on http://{a.host}:{a.port}{a.path} -> {a.inbox}" + (f" + exec {a.cmd!r}" if a.cmd else ""), file=sys.stderr)
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()

if __name__ == "__main__":
    main()
