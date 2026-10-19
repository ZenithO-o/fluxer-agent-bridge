#!/usr/bin/env python3
"""Read-only presence probe for a Fluxer bot account.
Opens an INVISIBLE observer session as the same bot (invisible never masks a visible session: precedence
dnd > online > idle > invisible), asks Request Guild Members (op 8) for the bot's own user with presences=true,
prints status + custom status, closes with 1000. Posts nothing.

Usage: presence-check.py --guild <guild_id> [--env bot.env] [--watch SECONDS]
bot.env: FLUXER_URL=https://your-fluxer.example  FLUXER_BOT_TOKEN=<app_id>.<secret>
Requires: pip install websockets
"""
import argparse, asyncio, json, os, sys, time
import websockets

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--env", default="bot.env"); ap.add_argument("--guild", required=True); ap.add_argument("--watch", type=float, default=0)
A = ap.parse_args()
env = {}
for l in open(os.path.expanduser(A.env)):
    if "=" in l and not l.lstrip().startswith("#"):
        k, v = l.strip().split("=", 1); env[k.strip()] = v.strip().strip('"\'')
TOK = env["FLUXER_BOT_TOKEN"]
URL = env.get("FLUXER_URL", "https://your-fluxer.example").rstrip("/").replace("https://", "wss://", 1) + "/gateway?v=1&encoding=json"

async def check():
    async with websockets.connect(URL, max_size=2**24) as ws:
        await ws.recv()
        await ws.send(json.dumps({'op': 2, 'd': {'token': TOK, 'properties': {'os': 'linux', 'browser': 'presence-check', 'device': 'cli'},
                                                'presence': {'status': 'invisible'}, 'ignored_events': ['TYPING_START', 'MESSAGE_CREATE', 'MESSAGE_UPDATE']}}))
        me = None; end = time.time() + 10
        while time.time() < end:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
            if m.get('t') == 'READY': me = m['d']['user']['id']
            if m.get('t') == 'GUILD_CREATE': break
        await ws.send(json.dumps({'op': 8, 'd': {'guild_id': A.guild, 'user_ids': [me], 'presences': True, 'nonce': 'pc1'}}))
        end = time.time() + 8
        while time.time() < end:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - time.time()))
            if m.get('t') == 'GUILD_MEMBERS_CHUNK':
                pres = [p for p in (m['d'].get('presences') or []) if (p.get('user') or {}).get('id') == me]
                await ws.close(code=1000)
                return (pres[0].get('status') if pres else 'offline'), ((pres[0].get('custom_status') or {}).get('text') if pres else None)
        await ws.close(code=1000)
        return 'unknown (no chunk)', None

async def main():
    t0 = time.time()
    while True:
        st, cs = await check()
        print(f"{time.strftime('%H:%M:%S')} +{time.time()-t0:5.1f}s presence={st}" + (f' "{cs}"' if cs else ''), flush=True)
        if time.time() - t0 >= A.watch: break
        await asyncio.sleep(3)
asyncio.run(main())
