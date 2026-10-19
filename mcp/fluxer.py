#!/usr/bin/env python3
"""Post as a named Fluxer bot, and store bridge webhook batches.

Stdout is MCP only for `mcp`. Logs go to stderr. Tokens are never printed.
`--bot <name>` is required. The token is ~/.config/fluxer-agent-bridge/bots/<name>.env.
`bin/fluxer` is this file. `listen` writes $FLUXER_INBOX. A container cannot dial 127.0.0.1.

Optional guild check: pass --guild <id> or --dm (MCP: guild_id or dm), or set FLUXER_CONTEXT_GUILD=<id>|dm, and the
target channel is resolved first; another guild, a non-DM for --dm, or an unknown channel is refused (exit 3) before
any write. With no context the write is not checked, unless FLUXER_REQUIRE_GUILD=1 (strict: no context is refused).
`events` gives each event a ready-to-copy `guild`.

  bin/fluxer --bot <name> [--guild <id>|--dm] [--dry-run] send <ch> <text...> [--reply-to <msg>]
  ... reply <ch> <msg> <text...> | react|unreact <ch> <msg> <emoji> | edit <ch> <msg> <text...> | delete <ch> <msg> | typing <ch>
  bin/fluxer --bot <name> whoami | channels | events [--cursor N] [--wait-ms MS]
  bin/fluxer bots | mcp | listen | selftest
"""

import hmac, json, os, re, sys, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
TEXTISH = {0, 5, 10, 11, 12}
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}")
INBOX_LOCK = threading.Lock()
SEEN = []
SEEN_LOCK = threading.Lock()


def redact(text):
    return TOKEN_RE.sub("<redacted>", str(text))


def default_env_path():
    return os.path.expanduser("~/.config/fluxer-agent-bridge/bot.env")


def default_inbox():
    return os.path.expanduser("~/.local/state/fluxer-agent-bridge/inbox.jsonl")


def parse_file(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def load_env():
    env = dict(os.environ)
    path = os.path.expanduser(env.get("FLUXER_ENV") or default_env_path())
    for key, value in parse_file(path).items():
        env.setdefault(key, value)
    return env


ENV = load_env()
BOT_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def bots_dir():
    return os.path.expanduser(cfg("FLUXER_BOTS_DIR") or "~/.config/fluxer-agent-bridge/bots")


def list_bots():
    folder = bots_dir()
    if not os.path.isdir(folder):
        return []
    return sorted(name[:-4] for name in os.listdir(folder) if name.endswith(".env") and BOT_NAME.match(name[:-4]))


BOT_REQUIRED = "bot name required: bin/fluxer --bot <name> <command>"


def select_bot(name):
    """Point later API calls at one bot file. An empty name is an error."""
    global ENV
    name = str(name or "").strip()
    if not name:
        raise SystemExit(BOT_REQUIRED)
    if not BOT_NAME.match(name):
        raise SystemExit(f"bad bot name: {name}")
    folder = bots_dir()
    path = os.path.join(folder, name + ".env")
    if not os.path.exists(path):
        raise SystemExit(f"no env file for {name}: {path}")
    ENV = load_env()
    ENV["FLUXER_BOTS_DIR"] = folder
    ENV.update(parse_file(path))
    ENV["FLUXER_BOT"] = name
    return name


def cfg(name, default=""):
    return ENV.get(name, default)


def inbox_path():
    return os.path.expanduser(cfg("FLUXER_INBOX") or default_inbox())


def webhook_token():
    return cfg("FLUXER_WEBHOOK_TOKEN") or cfg("WEBHOOK_TOKEN")


def api_base():
    return cfg("FLUXER_URL", "https://your-fluxer.example").rstrip("/") + "/api/v1"


def token():
    return cfg("FLUXER_BOT_TOKEN", "")


def api(method, path, body=None, timeout=30, empty=False):
    if not token():
        return {"_error": 0, "_body": "FLUXER_BOT_TOKEN is not set"}
    data = b"" if empty else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(
        api_base() + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bot " + token(),
            "User-Agent": "fluxer-mcp/1.0",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw or b"null")
    except urllib.error.HTTPError as exc:
        return {"_error": exc.code, "_body": redact(exc.read().decode(errors="replace")[:500])}
    except Exception as exc:
        return {"_error": 0, "_body": redact(exc)}


# ---------- optional guild check (strict with FLUXER_REQUIRE_GUILD=1) ----------
SNOWFLAKE = re.compile(r"^\d{5,25}$")
DM_TYPES = {1, 3}
CHAN_CACHE = {}
CHAN_TTL = 60


class Refused(Exception):
    pass


def strict_mode():
    return str(cfg("FLUXER_REQUIRE_GUILD") or "").strip().lower() in ("1", "true", "yes", "on")


def parse_ctx(guild=None, dm=False):
    """('guild', id), ('dm', None), or None (no check). Explicit beats FLUXER_CONTEXT_GUILD. guild "dm" equals dm."""
    g = str(guild or "").strip()
    if g.lower() == "dm":
        g, dm = "", True
    if g and dm:
        raise Refused("refused: pass guild or dm, not both")
    if dm:
        return ("dm", None)
    if g:
        if not SNOWFLAKE.match(g):
            raise Refused(f"refused: bad guild id {g}")
        return ("guild", g)
    env = str(cfg("FLUXER_CONTEXT_GUILD") or "").strip()
    if env:
        return parse_ctx(env, False) if env.lower() != "dm" else ("dm", None)
    if strict_mode():
        raise Refused("refused: no context guild (strict mode; pass --guild ID or --dm)")
    return None


def get_channel(channel_id):
    hit = CHAN_CACHE.get(channel_id)
    if hit and time.time() - hit[0] < CHAN_TTL:
        return hit[1]
    ch = api("GET", f"/channels/{channel_id}")
    if not isinstance(ch, dict) or "_error" in ch or "id" not in ch:
        return None
    CHAN_CACHE[channel_id] = (time.time(), ch)
    return ch


def check_target(channel_id, ctx):
    """Raise Refused unless channel_id is inside ctx. Reads only. ctx None = no check (returns None)."""
    if ctx is None:
        return None
    channel_id = str(channel_id or "")
    if not SNOWFLAKE.match(channel_id):
        raise Refused(f"refused: bad channel id {channel_id}")
    ch = get_channel(channel_id)
    if not ch:
        raise Refused(f"refused: channel {channel_id} not resolvable")
    guild = ch.get("guild_id")
    if not guild and ch.get("parent_id"):
        parent = get_channel(str(ch["parent_id"])) or {}
        guild = parent.get("guild_id")
    guild = str(guild) if guild else None
    kind, want = ctx
    if kind == "dm":
        if guild or ch.get("type") not in DM_TYPES:
            raise Refused(f"refused: channel {channel_id} is not a DM")
        return "dm"
    if not guild:
        raise Refused(f"refused: channel {channel_id} has no guild (context {want})")
    if guild != want:
        raise Refused(f"refused: channel {channel_id} is in guild {guild}, context is {want}")
    return guild


def typing(channel_id):
    return api("POST", f"/channels/{channel_id}/typing", {})


def send(channel_id, text, reply_to=None):
    typing(channel_id)
    body = {"content": text, "nonce": str(time.time_ns())[-18:]}
    if reply_to:
        body["message_reference"] = {"message_id": str(reply_to), "channel_id": str(channel_id)}
    return api("POST", f"/channels/{channel_id}/messages", body)


def edit(channel_id, message_id, text):
    return api("PATCH", f"/channels/{channel_id}/messages/{message_id}", {"content": text})


def delete(channel_id, message_id):
    return api("DELETE", f"/channels/{channel_id}/messages/{message_id}")


def reaction_path(channel_id, message_id, emoji):
    return f"/channels/{channel_id}/messages/{message_id}/reactions/{urllib.parse.quote(str(emoji), safe='')}/@me"


def react(channel_id, message_id, emoji, remove=False):
    return api("DELETE" if remove else "PUT", reaction_path(channel_id, message_id, emoji), empty=True)


def whoami():
    me = api("GET", "/users/@me")
    if not isinstance(me, dict) or "id" not in me:
        return me
    return {"id": me.get("id"), "username": me.get("username"), "bot": me.get("bot"), "name": cfg("FLUXER_BOT") or None}


def channels():
    guilds = api("GET", "/users/@me/guilds")
    if isinstance(guilds, dict) and guilds.get("_error") is not None:
        return guilds
    out = []
    for guild in guilds or []:
        gid = str(guild.get("id"))
        listed = api("GET", f"/guilds/{gid}/channels")
        rows = []
        if isinstance(listed, list):
            for ch in listed:
                if ch.get("type") not in TEXTISH:
                    continue
                rows.append({"id": ch.get("id"), "name": ch.get("name"), "type": ch.get("type")})
        out.append({"id": gid, "name": guild.get("name"), "channels": rows})
    dms = api("GET", "/users/@me/channels")
    if isinstance(dms, list):
        out.append({
            "id": None,
            "name": "dms",
            "channels": [{"id": ch.get("id"), "name": ch.get("name"), "type": ch.get("type")} for ch in dms],
        })
    return out


def append_batch(batch):
    path = inbox_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps({"received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "batch": batch}, separators=(",", ":"))
    with INBOX_LOCK:
        with open(path, "a") as fh:
            fh.write(line + "\n")
            fh.flush()
    return path


def read_events(cursor=0, limit=20, wait_ms=0, bot=None):
    path = inbox_path()
    cursor = max(0, int(cursor or 0))
    limit = max(1, min(int(limit or 20), 50))
    deadline = time.time() + max(0, min(int(wait_ms or 0), 20000)) / 1000
    while True:
        if os.path.exists(path):
            size = os.path.getsize(path)
            if size > cursor:
                with INBOX_LOCK:
                    with open(path) as fh:
                        fh.seek(cursor)
                        events = []
                        while len(events) < limit:
                            pos = fh.tell()
                            line = fh.readline()
                            if not line:
                                break
                            if not line.endswith("\n"):
                                fh.seek(pos)
                                break
                            try:
                                item = json.loads(line)
                                cursor = fh.tell()
                            except ValueError:
                                cursor = fh.tell()
                                continue
                            batch = item.get("batch") or {}
                            if bot and batch.get("bot") != bot and batch.get("target") != bot:
                                continue
                            item["guild"] = event_guild(batch)
                            events.append(item)
                return {"inbox": path, "events": events, "next_cursor": cursor}
        if time.time() >= deadline:
            return {"inbox": path, "events": [], "next_cursor": cursor}
        time.sleep(0.2)


def event_guild(batch):
    """Ready-to-copy context for writes: a guild id, "dm", or a list when one batch spans several."""
    seen = []
    for m in batch.get("messages") or []:
        g = m.get("guild_id") or ("dm" if m.get("is_dm") else None)
        if g and g not in seen:
            seen.append(str(g))
    return seen[0] if len(seen) == 1 else (seen or None)


def same(a, b):
    left, right = a.encode(), b.encode()
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


class WebhookHandler(BaseHTTPRequestHandler):
    path_ok = "/fluxer"
    token = ""

    def log_message(self, *_):
        return

    def _send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] == "/healthz":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != self.path_ok:
            return self._send(404, {"error": "not found"})
        expected = f"Bearer {self.token}" if self.token else ""
        if expected and not same(self.headers.get("Authorization", ""), expected):
            return self._send(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1024 * 1024:
            return self._send(413, {"error": "too large"})
        try:
            batch = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        key = self.headers.get("Idempotency-Key", "")
        with SEEN_LOCK:
            if key and key in SEEN:
                return self._send(200, {"ok": True, "duplicate": True})
            if key:
                SEEN.append(key)
                del SEEN[:-1000]
        append_batch(batch)
        self._send(200, {"ok": True, "stored": len(batch.get("messages") or [])})


def start_listener():
    host = cfg("FLUXER_WEBHOOK_HOST", "127.0.0.1")
    port = int(cfg("FLUXER_WEBHOOK_PORT", "8788") or 8788)
    path = cfg("FLUXER_WEBHOOK_PATH", "/fluxer")
    handler = type("H", (WebhookHandler,), {"path_ok": path, "token": webhook_token()})
    try:
        server = ThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        print(f"fluxer-mcp webhook not bound: {exc}", file=sys.stderr)
        return None
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="fluxer-webhook", daemon=True)
    thread.start()
    bound = server.server_address
    print(
        f"fluxer-mcp listening http://{bound[0]}:{bound[1]}{path} inbox={inbox_path()}",
        file=sys.stderr,
        flush=True,
    )
    return server


def tool_result(value, error=False):
    return {
        "content": [{"type": "text", "text": json.dumps(value, indent=2)}],
        "isError": error or (isinstance(value, dict) and value.get("_error") not in (None, 0) and "_error" in value and "id" not in value),
    }


def call_tool(name, args):
    args = args or {}
    if name == "bots":
        return tool_result({"bots": list_bots(), "dir": bots_dir()})
    try:
        select_bot(args.get("bot") or "")
    except SystemExit as exc:
        return tool_result({"_error": 2, "_body": str(exc)}, True)
    if name in WRITES:
        try:
            check_target(args.get("channel_id"), parse_ctx(args.get("guild_id"), bool(args.get("dm"))))
        except Refused as exc:
            return {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    if name == "whoami":
        value = whoami()
    elif name == "channels":
        value = channels()
    elif name == "typing":
        value = typing(str(args.get("channel_id", "")))
    elif name == "send":
        value = send(str(args.get("channel_id", "")), str(args.get("text", "")), args.get("reply_to"))
        if isinstance(value, dict) and "id" in value:
            value = {"id": value.get("id"), "channel_id": value.get("channel_id")}
    elif name == "reply":
        value = send(str(args.get("channel_id", "")), str(args.get("text", "")), args.get("message_id"))
        if isinstance(value, dict) and "id" in value:
            value = {"id": value.get("id"), "channel_id": value.get("channel_id")}
    elif name in ("react", "unreact"):
        value = react(str(args.get("channel_id", "")), str(args.get("message_id", "")), args.get("emoji", ""), remove=name == "unreact")
        if value is None or value == {}:
            return {"content": [{"type": "text", "text": "ok"}], "isError": False}
        return {"content": [{"type": "text", "text": short_error(value) if failed(value) else json.dumps(value)}], "isError": failed(value)}
    elif name == "edit":
        value = edit(str(args.get("channel_id", "")), str(args.get("message_id", "")), str(args.get("text", "")))
        if isinstance(value, dict) and "id" in value:
            value = {"id": value.get("id"), "channel_id": value.get("channel_id")}
    elif name == "delete":
        value = delete(str(args.get("channel_id", "")), str(args.get("message_id", "")))
    elif name == "events":
        value = read_events(args.get("cursor") or 0, args.get("limit") or 20, args.get("wait_ms") or 0, args.get("bot") or None)
    else:
        return {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True}
    failed = isinstance(value, dict) and "_error" in value and "id" not in value and name != "events"
    return tool_result(value, failed)


WRITES = {"typing", "send", "reply", "react", "unreact", "edit", "delete"}


def schema(fields, required):
    props = {name: {"type": kind} for name, kind in fields}
    out = {"type": "object", "properties": props}
    if required:
        out["required"] = required
    return out


def tool(name, description, fields, required):
    if name in WRITES:
        fields = fields + [("guild_id", S), ("dm", "boolean")]
    return {"name": name, "description": description, "inputSchema": schema(fields, required)}


S = "string"
I = "integer"
TOOLS = [
    tool("bots", "List local bot names. No tokens.", [], []),
    tool("whoami", "Return the bot user id and username.", [("bot", S)], ["bot"]),
    tool("channels", "List guilds and text channels the bot can see.", [("bot", S)], ["bot"]),
    tool("typing", "Start typing in a channel.", [("bot", S), ("channel_id", S)], ["bot", "channel_id"]),
    tool("send", "Type, then post.", [("bot", S), ("channel_id", S), ("text", S), ("reply_to", S)], ["bot", "channel_id", "text"]),
    tool("reply", "Type, then reply to message_id.", [("bot", S), ("channel_id", S), ("message_id", S), ("text", S)], ["bot", "channel_id", "message_id", "text"]),
    tool("react", "Add an emoji reaction. Pass the character or name:id.", [("bot", S), ("channel_id", S), ("message_id", S), ("emoji", S)], ["bot", "channel_id", "message_id", "emoji"]),
    tool("unreact", "Remove this bot's emoji reaction.", [("bot", S), ("channel_id", S), ("message_id", S), ("emoji", S)], ["bot", "channel_id", "message_id", "emoji"]),
    tool("edit", "Replace the text of a message this bot sent.", [("bot", S), ("channel_id", S), ("message_id", S), ("text", S)], ["bot", "channel_id", "message_id", "text"]),
    tool("delete", "Delete a message this bot can delete.", [("bot", S), ("channel_id", S), ("message_id", S)], ["bot", "channel_id", "message_id"]),
    tool("events", "Read inbox batches since cursor. wait_ms max 20000.", [("bot", S), ("cursor", I), ("limit", I), ("wait_ms", I)], ["bot"]),
]


def respond(msg_id, result=None, error=None):
    if error:
        payload = {"jsonrpc": "2.0", "id": msg_id, "error": error}
    else:
        payload = {"jsonrpc": "2.0", "id": msg_id, "result": result}
    sys.stdout.buffer.write(json.dumps(payload).encode() + b"\n")
    sys.stdout.buffer.flush()


def handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")
    if msg_id is None:
        return
    params = msg.get("params") or {}
    if method == "initialize":
        version = params.get("protocolVersion")
        if version not in PROTOCOL_VERSIONS:
            version = PROTOCOL_VERSIONS[0]
        respond(msg_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fluxer", "version": "1.0.0"},
            "instructions": "Pass bot. Optional guild_id (or dm=true) on writes asserts the target is in that server; a mismatch is refused. events returns raw batches.",
        })
    elif method == "ping":
        respond(msg_id, {})
    elif method == "tools/list":
        respond(msg_id, {"tools": TOOLS})
    elif method == "tools/call":
        respond(msg_id, call_tool(params.get("name"), params.get("arguments")))
    else:
        respond(msg_id, error={"code": -32601, "message": f"Method not found: {method}"})


def serve_mcp():
    start_listener()
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return
        text = line.decode().strip()
        if not text:
            continue
        try:
            msg = json.loads(text)
        except ValueError:
            print("fluxer-mcp ignored a non-JSON line", file=sys.stderr)
            continue
        try:
            handle(msg)
        except Exception as exc:
            if msg.get("id") is not None:
                respond(msg["id"], error={"code": -32603, "message": redact(exc)})


def failed(value):
    return isinstance(value, dict) and "_error" in value


def print_json(value, ok):
    sys.stdout.write(json.dumps(value, indent=2) + "\n")
    return 0 if ok else 1


def short_error(value):
    """One line, e.g. `HTTP 404: Unknown Message`."""
    body = str(value.get("_body", ""))
    try:
        body = json.loads(body).get("message") or body
    except (ValueError, AttributeError):
        pass
    code = value.get("_error")
    return (f"HTTP {code}: " if code else "error: ") + " ".join(str(body).split())[:120]


def print_action(value):
    if isinstance(value, dict) and "id" in value:
        print(value["id"])
        return 0
    if value is None or value == {}:
        print("ok")
        return 0
    if failed(value):
        print(short_error(value), file=sys.stderr)
        return 1
    print(json.dumps(value))
    return 0


def cli(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    bot, guild, dm, dry = "", None, False, False
    while argv and argv[0] in ("--bot", "--guild", "--dm", "--dry-run"):
        flag = argv.pop(0)
        if flag == "--dm":
            dm = True
        elif flag == "--dry-run":
            dry = True
        elif not argv:
            print(f"{flag} needs a value", file=sys.stderr)
            return 2
        elif flag == "--bot":
            bot = argv.pop(0)
        else:
            guild = argv.pop(0)
    if not argv:
        print(BOT_REQUIRED, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "bots":
        print("\n".join(list_bots()))
        return 0
    if cmd not in ("mcp", "listen", "selftest") and not bot:
        print(BOT_REQUIRED, file=sys.stderr)
        return 2
    if bot:
        try:
            select_bot(bot)
        except SystemExit as exc:
            print(exc, file=sys.stderr)
            return 2
    if cmd == "mcp":
        serve_mcp()
        return 0
    if cmd == "listen":
        server = start_listener()
        if not server:
            return 1
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            return 0
    if cmd == "selftest":
        return selftest()
    if cmd in WRITES:
        if not rest:
            print(__doc__)
            return 2
        try:
            where = check_target(rest[0], parse_ctx(guild, dm))
        except Refused as exc:
            print(exc, file=sys.stderr)
            return 3
        if dry:
            print(f"ok (dry run): {rest[0]} in {where}" if where else f"ok (dry run): {rest[0]} (no guild check)")
            return 0
    if cmd == "whoami":
        value = whoami()
        return print_json(value, isinstance(value, dict) and "id" in value)
    if cmd == "channels":
        value = channels()
        return print_json(value, isinstance(value, list))
    if cmd == "typing" and rest:
        value = typing(rest[0])
        return print_json(value, not (isinstance(value, dict) and "_error" in value))
    if cmd == "send" and len(rest) >= 2:
        reply_to = None
        if "--reply-to" in rest:
            i = rest.index("--reply-to")
            reply_to = rest[i + 1]
            del rest[i:i + 2]
        return print_action(send(rest[0], " ".join(rest[1:]), reply_to))
    if cmd == "reply" and len(rest) >= 3:
        return print_action(send(rest[0], " ".join(rest[2:]), rest[1]))
    if cmd == "react" and len(rest) >= 3:
        return print_action(react(rest[0], rest[1], rest[2]))
    if cmd == "unreact" and len(rest) >= 3:
        return print_action(react(rest[0], rest[1], rest[2], remove=True))
    if cmd == "edit" and len(rest) >= 3:
        return print_action(edit(rest[0], rest[1], " ".join(rest[2:])))
    if cmd == "delete" and len(rest) >= 2:
        return print_action(delete(rest[0], rest[1]))
    if cmd == "events":
        cursor, wait_ms = 0, 0
        if "--cursor" in rest:
            i = rest.index("--cursor")
            cursor = int(rest[i + 1])
        if "--wait-ms" in rest:
            i = rest.index("--wait-ms")
            wait_ms = int(rest[i + 1])
        value = read_events(cursor, 20, wait_ms, cfg("FLUXER_BOT") or None)
        return print_json(value, True)
    print(__doc__)
    return 2


def guard_selftest():
    """Optional guild check against a stub API: refusals never write, threads inherit their guild, DMs need dm."""
    import subprocess, tempfile
    G, H = "100000000000000010", "100000000000000099"
    chans = {"2000000001": {"id": "2000000001", "type": 0, "guild_id": G}, "2000000002": {"id": "2000000002", "type": 0, "guild_id": H},
             "2000000003": {"id": "2000000003", "type": 11, "parent_id": "2000000001"}, "2000000004": {"id": "2000000004", "type": 1}}
    seen = []

    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def _reply(self, code, obj):
            raw = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            seen.append("GET " + self.path)
            ch = chans.get(self.path.rsplit("/", 1)[-1])
            self._reply(200 if ch else 404, ch or {"message": "Unknown Channel"})

        def do_POST(self):
            seen.append("POST " + self.path)
            self._reply(200, {"id": "3000000001"})

        def do_PUT(self):
            seen.append("PUT " + self.path)
            self.send_response(204)
            self.end_headers()

        do_PATCH = do_DELETE = do_POST

    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    saved = dict(ENV)
    try:
        ENV.update({"FLUXER_URL": f"http://127.0.0.1:{server.server_address[1]}", "FLUXER_BOT_TOKEN": "stub", "FLUXER_CONTEXT_GUILD": ""})
        CHAN_CACHE.clear()
        for ch, ctx, want in (("2000000002", ("guild", G), "is in guild"), ("2000000009", ("guild", G), "not resolvable"),
                              ("2000000001", ("dm", None), "not a DM"), ("2000000004", ("guild", G), "has no guild")):
            try:
                check_target(ch, ctx)
                raise SystemExit(f"guard let {ch} through")
            except Refused as exc:
                assert want in str(exc), exc
        assert check_target("2000000003", ("guild", G)) == G
        assert check_target("2000000004", ("dm", None)) == "dm"
        assert parse_ctx() is None and check_target("2000000002", None) is None, "default: no context, no check"
        try:
            parse_ctx(G, True)
            raise SystemExit("guild and dm together accepted")
        except Refused:
            pass
        ENV["FLUXER_REQUIRE_GUILD"] = "1"
        try:
            parse_ctx()
            raise SystemExit("strict mode accepted no context")
        except Refused as exc:
            assert "strict" in str(exc)
        ENV["FLUXER_REQUIRE_GUILD"] = ""
        ENV["FLUXER_CONTEXT_GUILD"] = G
        assert parse_ctx() == ("guild", G) and parse_ctx("dm") == ("dm", None)
        assert not [x for x in seen if not x.startswith("GET ")], seen
        bots = tempfile.mkdtemp(prefix="fluxer-guard-")
        with open(os.path.join(bots, "g.env"), "w") as fh:
            fh.write(f"FLUXER_URL={ENV['FLUXER_URL']}\nFLUXER_BOT_TOKEN=stub\n")
        env = dict(os.environ, FLUXER_BOTS_DIR=bots, FLUXER_ENV=os.path.join(bots, "none.env"), FLUXER_CONTEXT_GUILD="", FLUXER_REQUIRE_GUILD="")
        run = lambda *a, **extra: subprocess.run([sys.executable, os.path.abspath(__file__), "--bot", "g", *a], env=dict(env, **extra), capture_output=True, text=True)
        r = run("--dry-run", "send", "2000000002", "hi")
        assert r.returncode == 0 and "no guild check" in r.stdout, r
        r = run("send", "2000000002", "hi", FLUXER_REQUIRE_GUILD="1")
        assert r.returncode == 3 and "strict" in r.stderr, r
        r = run("--guild", G, "send", "2000000002", "hi")
        assert r.returncode == 3 and "is in guild" in r.stderr, r
        r = run("--guild", G, "--dry-run", "reply", "2000000001", "2000000099", "hi")
        assert r.returncode == 0 and "dry run" in r.stdout, r
        assert not [x for x in seen if not x.startswith("GET ")], seen
        r = run("--guild", G, "send", "2000000001", "hi")
        assert r.returncode == 0 and r.stdout.strip() == "3000000001", r
        assert [x for x in seen if not x.startswith("GET ")] == ["POST /api/v1/channels/2000000001/typing", "POST /api/v1/channels/2000000001/messages"], seen
        r = run("--guild", H, "react", "2000000001", "2000000099", "\U0001f44d")
        assert r.returncode == 3 and "is in guild" in r.stderr and not seen[-1].startswith("PUT"), r
        r = run("--guild", G, "react", "2000000001", "2000000099", "\U0001f44d")
        assert r.returncode == 0 and r.stdout == "ok\n", r
        assert seen[-1] == "PUT /api/v1/channels/2000000001/messages/2000000099/reactions/%F0%9F%91%8D/@me", seen
        r = run("send", "2000000002", "cross-server on purpose")
        assert r.returncode == 0 and seen[-1] == "POST /api/v1/channels/2000000002/messages", (r, seen)
        os.remove(os.path.join(bots, "g.env"))
        os.rmdir(bots)
        return 0
    finally:
        ENV.clear()
        ENV.update(saved)
        CHAN_CACHE.clear()
        server.shutdown()


def selftest():
    import subprocess, tempfile
    saved = dict(ENV)
    folder = tempfile.mkdtemp(prefix="fluxer-bots-")
    try:
        try:
            select_bot("")
            raise SystemExit("empty bot name was accepted")
        except SystemExit as exc:
            if "bot name required" not in str(exc):
                raise
        for name, secret in (("alpha", "alpha-secret"), ("beta", "beta-secret")):
            with open(os.path.join(folder, name + ".env"), "w") as fh:
                fh.write(f"FLUXER_BOT_TOKEN={secret}\n")
        ENV["FLUXER_BOTS_DIR"] = folder
        select_bot("alpha")
        assert cfg("FLUXER_BOT_TOKEN") == "alpha-secret"
        select_bot("beta")
        assert cfg("FLUXER_BOT_TOKEN") == "beta-secret"
        assert "alpha" not in cfg("FLUXER_BOT_TOKEN")
    finally:
        ENV.clear()
        ENV.update(saved)
        for name in ("alpha.env", "beta.env"):
            path = os.path.join(folder, name)
            if os.path.exists(path):
                os.remove(path)
        os.rmdir(folder)
    inbox = os.path.join(tempfile.mkdtemp(prefix="fluxer-mcp-"), "inbox.jsonl")
    bots = tempfile.mkdtemp(prefix="fluxer-mcp-bots-")
    with open(os.path.join(bots, "selftest.env"), "w") as fh:
        fh.write("FLUXER_URL=https://example.invalid\nFLUXER_BOT_TOKEN=not-used\n")
    env = dict(os.environ)
    env.update({
        "FLUXER_ENV": os.path.join(tempfile.gettempdir(), "fluxer-mcp-missing.env"),
        "FLUXER_BOTS_DIR": bots,
        "FLUXER_INBOX": inbox,
        "FLUXER_WEBHOOK_PORT": "0",
        "FLUXER_WEBHOOK_TOKEN": "selftest-key",
        "FLUXER_BOT_TOKEN": "",
    })
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "mcp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    try:
        line = proc.stderr.readline().decode()
        if "listening http://" not in line:
            print(line, file=sys.stderr)
            return 1
        url = line.split("listening ", 1)[1].split()[0]

        def rpc(msg):
            proc.stdin.write((json.dumps(msg) + "\n").encode())
            proc.stdin.flush()
            return json.loads(proc.stdout.readline().decode())

        init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "selftest", "version": "0"}}})
        assert init["result"]["protocolVersion"] == "2025-11-25", init
        proc.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        proc.stdin.flush()
        listed = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t["name"] for t in listed["result"]["tools"]]
        assert names == ["bots", "whoami", "channels", "typing", "send", "reply", "react", "unreact", "edit", "delete", "events"], names
        assert reaction_path("1", "2", "\U0001f44d").endswith("/reactions/%F0%9F%91%8D/@me")
        missing = rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})
        assert missing["result"]["isError"] is True
        assert "bot name required" in missing["result"]["content"][0]["text"]
        req = urllib.request.Request(url, data=json.dumps({"source": "selftest", "bot": "selftest", "messages": [{"id": "1", "content": "hi"}]}).encode(), method="POST", headers={"Authorization": "Bearer selftest-key", "Content-Type": "application/json", "Idempotency-Key": "selftest-1"})
        with urllib.request.urlopen(req, timeout=5) as res:
            assert res.status == 200
        got = rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "events", "arguments": {"bot": "selftest", "cursor": 0}}})
        body = json.loads(got["result"]["content"][0]["text"])
        assert body["events"][0]["batch"]["source"] == "selftest", body
        denied = urllib.request.Request(url, data=b"{}", method="POST")
        try:
            urllib.request.urlopen(denied, timeout=5)
            raise SystemExit("unauthenticated post was accepted")
        except urllib.error.HTTPError as exc:
            assert exc.code == 401
        refused = rpc({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "send", "arguments": {"bot": "selftest", "guild_id": "100000000000000010", "channel_id": "100000000000000030", "text": "x"}}})
        assert refused["result"]["isError"] is True and "not resolvable" in refused["result"]["content"][0]["text"], refused
        props = [t for t in listed["result"]["tools"] if t["name"] == "send"][0]["inputSchema"]["properties"]
        assert "guild_id" in props and "dm" in props
        if guard_selftest() != 0:
            return 1
        print("selftest ok")
        return 0
    finally:
        proc.kill()
        proc.wait(timeout=5)
        if os.path.exists(inbox):
            os.remove(inbox)
            os.rmdir(os.path.dirname(inbox))
        envfile = os.path.join(bots, "selftest.env")
        if os.path.exists(envfile):
            os.remove(envfile)
            os.rmdir(bots)


if __name__ == "__main__":
    try:
        sys.exit(cli(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(0)
    except Exception as exc:
        print(redact(exc), file=sys.stderr)
        sys.exit(1)
