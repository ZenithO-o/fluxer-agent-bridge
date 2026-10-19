// fluxer-agent-bridge CLI (runs inside the container):
//   node dist/cli.js health            exit 0 if /healthz is 200 (Docker HEALTHCHECK)
//   node dist/cli.js status            print a per-bot table (no secrets)
//   node dist/cli.js test-webhook BOT  POST one synthetic test batch (test:true) to BOT's webhook; never touches Fluxer
//   node dist/cli.js activity BOT STATE [--user ID] [--nick NICK] [--channel ID] [--message ID] [--at EPOCH_MS]
//        STATE = responding | idle | show   (activity-status plugin; loopback control endpoint, see README)
import fs from 'node:fs';
import path from 'node:path';
import { CFG_DIR, OWNER, parseEnvFile } from './config.js';

const PORT = Number(process.env.BB_HEALTH_PORT || 8080);
const [cmd, arg] = process.argv.slice(2);

async function health() {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) });
  return { code: r.status, body: (await r.json()) as any };
}

if (cmd === 'health') {
  health().then((h) => process.exit(h.code === 200 ? 0 : 1)).catch(() => process.exit(1));
} else if (cmd === 'status') {
  health().then(({ body }) => {
    console.log(`owner ${body.owner}  overall ${body.ok ? 'healthy' : 'UNHEALTHY'}  uptime ${body.uptime_s}s`);
    for (const e of body.config_errors) console.log(`  config error: ${e}`);
    for (const b of body.bots) {
      const wf = b.plugins.find((p: any) => p.name === 'webhook-forward');
      console.log(`  ${b.bot.padEnd(16)} ${b.state.padEnd(12)} presence=${b.presence.status}${b.presence.customStatus?.text ? ` "${b.presence.customStatus.text}"` : ''}`
        + ` ack=${b.last_ack_s_ago}s sessions=${b.sessions} resumes=${b.resumes}` + (b.fail_reason ? ` FAILED: ${b.fail_reason}` : '')
        + (wf ? ` | webhook=${wf.state} host=${wf.webhook_host ?? '-'} outbox=${wf.outbox} dropped=${wf.dropped} last=${wf.lastDelivery ?? '-'}${wf.lastError ? ` err=${wf.lastError}` : ''}` : ''));
    }
  }).catch((e) => { console.error(`health endpoint unreachable: ${e.message}`); process.exit(1); });
} else if (cmd === 'test-webhook' && arg && /^[a-z0-9_]{1,32}$/.test(arg)) {
  const sec = parseEnvFile(fs.readFileSync(path.join(CFG_DIR, arg, 'secrets.env'), 'utf8'));
  const url = sec.WEBHOOK_URL; const auth = sec.WEBHOOK_AUTH || (sec.WEBHOOK_KEY ? `Bearer ${sec.WEBHOOK_KEY}` : '');
  if (!url) { console.error('WEBHOOK_URL not set'); process.exit(2); }
  const body = { source: 'fluxer-agent-bridge', schema: 2, owner: OWNER, bot: arg, target: arg, test: true, synthetic: true,
    messages: [{ event: 'create', id: '0', channel_id: '0', channel_name: 'bridge-test', guild_id: null, guild_name: null, is_dm: false,
      author: { id: '0', username: 'fluxer-agent-bridge', display_name: 'fluxer-agent-bridge (synthetic test)', bot: true }, timestamp: new Date().toISOString(),
      edited_timestamp: null, content: 'fluxer-agent-bridge test, please ignore', attachments: [], reply_to: null, reference: null, thread: null, reason: 'test', test: true }] };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'fluxer-agent-bridge/1.0' };
  if (auth) headers.Authorization = auth;
  if (!sec.WEBHOOK_AUTH && sec.WEBHOOK_KEY) headers['X-Automation-Key'] = sec.WEBHOOK_KEY;
  fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    .then(async (r) => { const t = (await r.text()).slice(0, 200); console.log(`HTTP ${r.status} from ${new URL(url).host}; response: ${t.replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')}`); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(`request failed: ${e.message}`); process.exit(1); });
} else if (cmd === 'activity' && arg && /^[a-z0-9_]{1,32}$/.test(arg)) {
  const rest = process.argv.slice(4);
  const state = rest.shift() ?? 'show';
  const args: Record<string, unknown> = { state };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, ''); const v = rest[i + 1];
    if (!k || v === undefined || !['user', 'nick', 'channel', 'message', 'at'].includes(k)) { console.error(`bad option ${rest[i]}`); process.exit(2); }
    args[k] = k === 'at' ? Number(v) : v;
  }
  fetch(`http://127.0.0.1:${PORT}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bot: arg, command: 'activity', args }), signal: AbortSignal.timeout(5000) })
    .then(async (r) => { const t = await r.text(); console.log(t); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(`control endpoint unreachable: ${e.message}`); process.exit(1); });
} else {
  console.error('usage: cli.js health | status | test-webhook <bot> | activity <bot> <responding|idle|show> [--user ID] [--nick NICK] [--channel ID] [--message ID] [--at MS]'); process.exit(2);
}
