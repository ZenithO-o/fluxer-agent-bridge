#!/usr/bin/env python3
"""agent_post.py: minimal REST helper for an agent that replies as its Fluxer bot (stdlib only).

Library:  from agent_post import api, reply
          reply(channel_id, "text", reply_to=message_id)      # signals Responding, then posts
          api("GET", f"/channels/{cid}/messages?limit=5")
CLI:      agent_post.py send <channel_id> <text...> [--reply-to <message_id>]

Config (env vars, or an env file at $FLUXER_ENV, default ./bot.env):
  FLUXER_URL=https://your-fluxer.example    FLUXER_BOT_TOKEN=<app_id>.<secret>
Optional precise Responding through the bridge host (see README "Signalling Responding"):
  BB_SSH=user@bridge-host  BB_HOME=/path/to/fluxer-agent-bridge  BB_OWNER=<owner>  BB_BOT=<bot>
Disable all status signalling with FX_NO_STATUS=1. Status signals are best-effort and never block or fail a post.
"""
import json, os, re, shlex, shutil, ssl, subprocess, sys, time, urllib.request, urllib.error

def _load_env():
    env = dict(os.environ)
    path = os.path.expanduser(os.environ.get("FLUXER_ENV", "bot.env"))
    if os.path.exists(path):
        for l in open(path):
            l = l.strip()
            if "=" in l and not l.startswith("#"):
                k, v = l.split("=", 1); env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env

ENV = _load_env()
BASE = ENV.get("FLUXER_URL", "https://your-fluxer.example").rstrip("/") + "/api/v1"
TOKEN = ENV.get("FLUXER_BOT_TOKEN", "")
CTX = ssl.create_default_context()
_POST_RE = re.compile(r"^/channels/(\d+)/messages/?$")

def signal_typing(channel_id, timeout=2.0):
    """Universal Responding signal: the bot's own typing indicator. True on 2xx. Never raises."""
    try:
        r = urllib.request.Request(f"{BASE}/channels/{channel_id}/typing", method="POST", data=b"",
            headers={"Authorization": "Bot " + TOKEN, "User-Agent": "agent-post/1.0", "Content-Length": "0"})
        with urllib.request.urlopen(r, timeout=timeout, context=CTX) as f: return 200 <= f.status < 300
    except Exception:
        return False

def signal_responding(channel_id, message_id=None, user_id=None):
    """Precise Responding via bin/status.sh over ssh, detached (never waited on). Needs BB_SSH etc. Never raises."""
    try:
        host, home = ENV.get("BB_SSH"), ENV.get("BB_HOME")
        owner, bot = ENV.get("BB_OWNER"), ENV.get("BB_BOT")
        if not (host and home and owner and bot and shutil.which("ssh")): return False
        remote = ["sudo", f"{home}/bin/status.sh", owner, bot, "responding", str(user_id or "-"),
                  str(channel_id or "-"), str(message_id or "-"), str(int(time.time() * 1000))]
        subprocess.Popen(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", host, " ".join(shlex.quote(x) for x in remote)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return True
    except Exception:
        return False

def _before_post(p, body):
    try:
        if ENV.get("FX_NO_STATUS"): return
        m = _POST_RE.match(p.split("?", 1)[0])
        if not m: return
        ref = (body.get("message_reference") or {}) if isinstance(body, dict) else {}
        if ref.get("message_id"): signal_responding(ref.get("channel_id") or m.group(1), ref.get("message_id"))
        signal_typing(m.group(1))
    except Exception:
        pass

def api(method, p, body=None):
    """Call the Fluxer REST API as the bot. Returns parsed JSON, or {"_error": status, "_body": text}."""
    if method.upper() == "POST": _before_post(p, body)
    r = urllib.request.Request(BASE + p, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Authorization": "Bot " + TOKEN, "User-Agent": "agent-post/1.0"})
    try:
        with urllib.request.urlopen(r, timeout=30, context=CTX) as f: return json.loads(f.read() or b"null")
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode(errors="replace")[:500]}

def reply(channel_id, text, reply_to=None):
    body = {"content": text, "nonce": str(time.time_ns())[-18:]}
    if reply_to: body["message_reference"] = {"message_id": str(reply_to), "channel_id": str(channel_id)}
    return api("POST", f"/channels/{channel_id}/messages", body)

if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == "send":
        ref = None
        if "--reply-to" in a: i = a.index("--reply-to"); ref = a[i + 1]; del a[i:i + 2]
        if not TOKEN: sys.exit("FLUXER_BOT_TOKEN not set")
        out = reply(a[1], " ".join(a[2:]), ref)
        print(out.get("id") if isinstance(out, dict) and "id" in out else json.dumps(out)); sys.exit(0 if "id" in (out or {}) else 1)
    print(__doc__); sys.exit(2)
