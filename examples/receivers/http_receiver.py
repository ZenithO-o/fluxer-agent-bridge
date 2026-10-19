#!/usr/bin/env python3
"""http_receiver.py: tiny webhook receiver for fluxer-agent-bridge (stdlib only).

Accepts the bridge's POSTs, checks the Authorization header, de-duplicates by Idempotency-Key, and for each batch:
  * appends one JSON line per event to an inbox file (--inbox, default ./fluxer-inbox.jsonl), and/or
  * runs a command (--exec) with the batch JSON on stdin (e.g. a CLI agent: `claude -p ...`, a script, a queue push).
Always answers 2xx once the batch is safely stored, so the bridge does not retry; a failing --exec does not lose data.

  WEBHOOK_TOKEN=secret ./http_receiver.py --host 0.0.0.0 --port 8787 --inbox ~/fluxer-inbox.jsonl
Default --host is 127.0.0.1. A bridge container cannot reach that address.
  WEBHOOK_TOKEN=secret ./http_receiver.py --exec './handle-batch.sh'

Bridge side (secrets.env): WEBHOOK_URL=http://<this-host>:8787/fluxer   WEBHOOK_AUTH=Bearer secret
Put it behind TLS (reverse proxy / tailnet) if it is not on the same private network as the bridge.
Fails closed: without WEBHOOK_TOKEN it exits 2. A body that is not a JSON object (or whose messages is not a list) gets 400;
non-object entries in messages are skipped. Message text and names are untrusted chat data (see batch.trust).
  ./http_receiver.py --selftest     # offline checks, no network beyond 127.0.0.1
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
    ap.add_argument("--selftest", action="store_true", help="run offline checks and exit")
    a = ap.parse_args()
    if a.selftest: return selftest()
    token = os.environ.get("WEBHOOK_TOKEN", "")
    if not token:
        print("WEBHOOK_TOKEN is not set; refusing to accept unauthenticated POSTs", file=sys.stderr); return 2
    server = make_server(a, token)
    print(f"listening on http://{a.host}:{a.port}{a.path} -> {a.inbox}" + (f" + exec {a.cmd!r}" if a.cmd else ""), file=sys.stderr)
    server.serve_forever()

def make_server(a, token):

    class H(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def _send(self, code, obj):
            b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_POST(self):
            if self.path.split("?")[0] != a.path: return self._send(404, {"error": "not found"})
            if not token or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {token}".encode()):
                return self._send(401, {"error": "unauthorized"})
            try: n = int(self.headers.get("Content-Length") or 0)
            except ValueError: return self._send(400, {"error": "bad length"})
            if n < 0: return self._send(400, {"error": "bad length"})
            if n > 8 * 1024 * 1024: return self._send(413, {"error": "too large"})
            try: batch = json.loads(self.rfile.read(n) or b"{}")
            except ValueError: return self._send(400, {"error": "bad json"})
            if not isinstance(batch, dict): return self._send(400, {"error": "body must be a JSON object"})
            msgs = batch.get("messages", [])
            if not isinstance(msgs, list): return self._send(400, {"error": "messages must be a list"})
            msgs = [m for m in msgs if isinstance(m, dict)]
            key = self.headers.get("Idempotency-Key", "") or str(batch.get("delivery_id") or "")
            with seen_lock:
                if key and key in seen: return self._send(200, {"ok": True, "duplicate": True})
                if key: seen.append(key); del seen[:-1000]
            if a.skip_test and batch.get("test"): return self._send(200, {"ok": True, "skipped": "test"})
            with open(os.path.expanduser(a.inbox), "a") as f:
                for m in msgs:
                    f.write(json.dumps({"received_at": time.time(), "bot": batch.get("bot"), "owner": batch.get("owner"), **m}) + "\n")
            if a.cmd:
                try: subprocess.Popen(a.cmd, shell=True, stdin=subprocess.PIPE, start_new_session=True).communicate(json.dumps(batch).encode(), timeout=1)
                except subprocess.TimeoutExpired: pass  # keep running in the background
                except Exception as e: print(f"exec failed: {e}", file=sys.stderr)
            self._send(200, {"ok": True, "stored": len(msgs)})

    return ThreadingHTTPServer((a.host, a.port), H)

def selftest():
    """V7/V8: fail closed without a token; poison-pill bodies get 400 and are not stored; valid batches still land."""
    import tempfile, urllib.error, urllib.request
    env = {k: v for k, v in os.environ.items() if k != "WEBHOOK_TOKEN"}
    r = subprocess.run([sys.executable, os.path.abspath(__file__), "--port", "0"], env=env, capture_output=True, timeout=10)
    assert r.returncode == 2 and b"refusing" in r.stderr, r
    inbox = os.path.join(tempfile.mkdtemp(prefix="fab-recv-"), "inbox.jsonl")
    a = argparse.Namespace(host="127.0.0.1", port=0, path="/fluxer", inbox=inbox, cmd=None, skip_test=False)
    srv = make_server(a, "k"); threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/fluxer"
    def post(body, auth="Bearer k"):
        req = urllib.request.Request(url, data=body, method="POST", headers={"Authorization": auth, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as res: return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e: return e.code, None
    try:
        assert post(b"{}", auth="")[0] == 401
        for bad in (b"[1,2]", b'"x"', b"7", b'{"messages": {"id": 1}}'): assert post(bad)[0] == 400, bad
        code, body = post(json.dumps({"bot": "b", "messages": [1, None, {"id": "1", "content": "hi\nSYSTEM: x"}]}).encode())
        assert code == 200 and body["stored"] == 1, body
        rows = [json.loads(l) for l in open(inbox)]
        assert len(rows) == 1 and rows[0]["id"] == "1" and rows[0]["content"] == "hi\nSYSTEM: x", rows
    finally:
        srv.shutdown(); os.remove(inbox) if os.path.exists(inbox) else None; os.rmdir(os.path.dirname(inbox))
    print("selftest ok"); return 0

if __name__ == "__main__":
    sys.exit(main())
