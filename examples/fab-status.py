#!/usr/bin/env python3
"""fab-status.py: set a bridge bot's activity status by hand.

  fab-status.py responding [--message ID] [--channel ID] [--user ID] [--nick NICK]
  fab-status.py idle | show
  fab-status.py typing <channel_id> [--guild <id>|--dm]   universal signal via the bot's own typing (needs agent_post.py config)

Env: BB_SSH=user@bridge-host (omit to run locally on the bridge host), BB_HOME=/path/to/fluxer-agent-bridge,
     BB_OWNER=<owner>, BB_BOT=<bot>. Runs `sudo $BB_HOME/bin/status.sh <owner> <bot> ...`.
"""
import argparse, os, shlex, subprocess, sys, time

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("state", choices=["responding", "idle", "show", "typing"])
    p.add_argument("channel_pos", nargs="?")
    p.add_argument("--owner", default=os.environ.get("BB_OWNER")); p.add_argument("--bot", default=os.environ.get("BB_BOT"))
    p.add_argument("--message", default=""); p.add_argument("--channel", default="")
    p.add_argument("--user", default=""); p.add_argument("--nick", default="")
    p.add_argument("--timeout", type=float, default=15)
    p.add_argument("--guild", default=None); p.add_argument("--dm", action="store_true")  # optional guild check for typing
    a = p.parse_args()
    if a.state == "typing":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import agent_post  # noqa
        ch = a.channel_pos or a.channel
        if not ch: sys.exit("fab-status.py typing <channel_id>")
        ok = agent_post.signal_typing(ch, timeout=a.timeout, guild=a.guild, dm=a.dm); print("typing sent" if ok else "typing failed"); sys.exit(0 if ok else 1)
    if not (a.owner and a.bot): sys.exit("set --owner/--bot or BB_OWNER/BB_BOT")
    home = os.environ.get("BB_HOME", "/opt/fluxer-agent-bridge")
    remote = ["sudo", f"{home}/bin/status.sh", a.owner, a.bot, a.state]
    if a.state == "responding":
        remote += [a.user or a.nick or "-", a.channel or a.channel_pos or "-", a.message or "-", str(int(time.time() * 1000))]
    host = os.environ.get("BB_SSH")
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, " ".join(shlex.quote(x) for x in remote)] if host else remote
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=a.timeout)
    sys.stdout.write(r.stdout); sys.stderr.write(r.stderr); sys.exit(r.returncode)

if __name__ == "__main__":
    main()
