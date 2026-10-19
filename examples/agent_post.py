#!/usr/bin/env python3
"""agent_post.py: minimal REST helper for an agent that replies as its Fluxer bot (stdlib only).

Library:  from agent_post import api, reply, GuildRefused
          reply(channel_id, "text", reply_to=message_id, guild=batch_msg["guild_id"])   # or dm=True
          api("GET", f"/channels/{cid}/messages?limit=5")
CLI:      agent_post.py (--guild <id> | --dm) send <channel_id> <text...> [--reply-to <message_id>]
Writes are guild-pinned: the channel must be in that guild (or a DM for dm), else GuildRefused / exit 3, nothing sent.

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

# --- guild pinning : a write may only land in the guild (or DM) it is answering -----------------------
# Every non-GET call needs a context: api(..., guild="<payload guild_id>") or api(..., dm=True) (guild="dm" works too),
# else env FLUXER_CONTEXT_GUILD=<id>|dm. The target channel is resolved first (GET /channels/{id}, cached 60 s; threads
# inherit their guild). Another guild, a non-DM for dm, an unknown channel, or no context raises GuildRefused BEFORE any
# write. It raises (never returns quietly), so a refused post is always visible to the caller.
class GuildRefused(Exception):
    """A write was refused before anything was sent."""

_SNOW=re.compile(r"^\d{5,25}$"); _CHAN_PATH=re.compile(r"^/channels/(\d+)(?:/|$)"); _CHAN_CACHE={}

def _get_channel(cid):
    hit=_CHAN_CACHE.get(cid)
    if hit and time.time()-hit[0]<60: return hit[1]
    try:
        r=urllib.request.Request(f"{BASE}/channels/{cid}",headers={"Authorization":"Bot "+TOKEN,"User-Agent":"agent-post/1.0"})
        with urllib.request.urlopen(r,timeout=10,context=CTX) as f: ch=json.loads(f.read() or b"null")
    except Exception:
        return None
    if not isinstance(ch,dict) or "id" not in ch: return None
    _CHAN_CACHE[cid]=(time.time(),ch); return ch

def _context(guild=None,dm=False):
    g=str(guild or "").strip()
    if g.lower()=="dm": g,dm="",True
    if g and dm: raise GuildRefused("refused: pass guild or dm, not both")
    if dm: return ("dm",None)
    if g:
        if not _SNOW.match(g): raise GuildRefused(f"refused: bad guild id {g}")
        return ("guild",g)
    env=os.environ.get("FLUXER_CONTEXT_GUILD","").strip()
    if env: return _context(env)
    raise GuildRefused("refused: no context guild (pass guild=<payload guild_id> or dm=True; CLI: --guild ID or --dm)")

def check_target(channel_id,guild=None,dm=False):
    """Return the matching guild id (or "dm"); raise GuildRefused otherwise. Reads only."""
    kind,want=_context(guild,dm); cid=str(channel_id or "")
    if not _SNOW.match(cid): raise GuildRefused(f"refused: bad channel id {cid}")
    ch=_get_channel(cid)
    if not ch: raise GuildRefused(f"refused: channel {cid} not resolvable")
    g=ch.get("guild_id") or ((_get_channel(str(ch["parent_id"])) or {}).get("guild_id") if ch.get("parent_id") else None)
    g=str(g) if g else None
    if kind=="dm":
        if g or ch.get("type") not in (1,3): raise GuildRefused(f"refused: channel {cid} is not a DM")
        return "dm"
    if not g: raise GuildRefused(f"refused: channel {cid} has no guild (context {want})")
    if g!=want: raise GuildRefused(f"refused: channel {cid} is in guild {g}, context is {want}")
    return g

def _guard_write(method,p,guild,dm):
    path=p.split("?",1)[0]
    if method.upper()=="POST" and path.rstrip("/")=="/users/@me/channels": return  # opening a DM channel posts nothing
    m=_CHAN_PATH.match(path)
    if not m: raise GuildRefused(f"refused: {method.upper()} {path} is not a channel write")
    check_target(m.group(1),guild,dm)

def signal_typing(channel_id, timeout=2.0, guild=None, dm=False, _checked=False):
    """Universal Responding signal: the bot's own typing indicator. True on 2xx. Never raises. Guild-pinned like api()."""
    if not _checked:
        try: check_target(channel_id, guild, dm)
        except GuildRefused as e: print(e, file=sys.stderr); return False
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
        signal_typing(m.group(1), _checked=True)
    except Exception:
        pass

def api(method, p, body=None, guild=None, dm=False):
    """Call the Fluxer REST API as the bot. Returns parsed JSON, or {"_error": status, "_body": text}.
    Writes need guild= or dm= (raises GuildRefused before sending otherwise)."""
    if method.upper() not in ("GET", "HEAD"): _guard_write(method, p, guild, dm)
    if method.upper() == "POST": _before_post(p, body)
    r = urllib.request.Request(BASE + p, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Authorization": "Bot " + TOKEN, "User-Agent": "agent-post/1.0"})
    try:
        with urllib.request.urlopen(r, timeout=30, context=CTX) as f: return json.loads(f.read() or b"null")
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode(errors="replace")[:500]}

def reply(channel_id, text, reply_to=None, guild=None, dm=False):
    body = {"content": text, "nonce": str(time.time_ns())[-18:]}
    if reply_to: body["message_reference"] = {"message_id": str(reply_to), "channel_id": str(channel_id)}
    return api("POST", f"/channels/{channel_id}/messages", body, guild=guild, dm=dm)

if __name__ == "__main__":
    a = sys.argv[1:]
    guild, dm = None, False
    while a and a[0] in ("--guild", "--dm"):
        f = a.pop(0)
        if f == "--dm": dm = True
        elif a: guild = a.pop(0)
    if len(a) >= 3 and a[0] == "send":
        ref = None
        if "--reply-to" in a: i = a.index("--reply-to"); ref = a[i + 1]; del a[i:i + 2]
        if not TOKEN: sys.exit("FLUXER_BOT_TOKEN not set")
        try: out = reply(a[1], " ".join(a[2:]), ref, guild=guild, dm=dm)
        except GuildRefused as e: print(e, file=sys.stderr); sys.exit(3)
        print(out.get("id") if isinstance(out, dict) and "id" in out else json.dumps(out)); sys.exit(0 if "id" in (out or {}) else 1)
    print(__doc__); sys.exit(2)
