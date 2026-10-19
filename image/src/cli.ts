// Not the supervisor. main.ts is PID 1. Docker HEALTHCHECK and bin/*.sh call this file.
import fs from 'node:fs';
import path from 'node:path';
import { CFG_DIR, INSTANCE, OWNER, parseEnvFile } from './config.js';
import { trustBlock } from './untrusted.js';
import { guard, parseCtx, truthy } from './guard.js';
import { parse as parseToml } from 'smol-toml';

const PORT = Number(process.env.BB_HEALTH_PORT || 8080);
const [cmd, arg] = process.argv.slice(2);

async function health() {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) });
  return { code: r.status, body: (await r.json()) as any };
}

function redact(text: string) {
  return text.replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
}

if (cmd === 'health') {
  health().then((h) => process.exit(h.code === 200 ? 0 : 1)).catch(() => process.exit(1));
} else if (cmd === 'status') {
  health().then(({ body }) => {
    console.log(`owner ${body.owner}  overall ${body.ok ? 'healthy' : 'UNHEALTHY'}  uptime ${body.uptime_s}s`);
    for (const e of body.config_errors) console.log(`  config error: ${e}`);
    for (const b of body.bots) {
      const wf = b.plugins.find((p: any) => p.name === 'webhook-forward');
      const presence = `presence=${b.presence.status}${b.presence.customStatus?.text ? ` "${b.presence.customStatus.text}"` : ''}`;
      const session = `ack=${b.last_ack_s_ago}s sessions=${b.sessions} resumes=${b.resumes}`;
      const failed = b.fail_reason ? ` FAILED: ${b.fail_reason}` : '';
      const webhook = wf
        ? ` | webhook=${wf.state} host=${wf.webhook_host ?? '-'} outbox=${wf.outbox} dropped=${wf.dropped} last=${wf.lastDelivery ?? '-'}${wf.lastError ? ` err=${wf.lastError}` : ''}`
        : '';
      console.log(`  ${b.bot.padEnd(16)} ${b.state.padEnd(12)} ${presence} ${session}${failed}${webhook}`);
    }
  }).catch((e) => {
    console.error(`health endpoint unreachable: ${e.message}`);
    process.exit(1);
  });
} else if (cmd === 'test-webhook' && arg && /^[a-z0-9_]{1,32}$/.test(arg)) {
  const sec = parseEnvFile(fs.readFileSync(path.join(CFG_DIR, arg, 'secrets.env'), 'utf8'));
  const url = sec.WEBHOOK_URL;
  const auth = sec.WEBHOOK_AUTH || (sec.WEBHOOK_KEY ? `Bearer ${sec.WEBHOOK_KEY}` : '');
  if (!url) {
    console.error('WEBHOOK_URL not set');
    process.exit(2);
  }
  const body = {
    source: 'fluxer-agent-bridge',
    schema: 2,
    owner: OWNER,
    bot: arg,
    target: arg,
    test: true,
    synthetic: true,
    trust: trustBlock(false),
    messages: [{
      event: 'create',
      id: '0',
      channel_id: '0',
      channel_name: 'bridge-test',
      guild_id: null,
      guild_name: null,
      is_dm: false,
      author: { id: '0', username: 'fluxer-agent-bridge', display_name: 'fluxer-agent-bridge (synthetic test)', bot: true },
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      content: 'fluxer-agent-bridge test, please ignore',
      attachments: [],
      reply_to: null,
      reference: null,
      thread: null,
      reason: 'test',
      test: true,
    }],
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'fluxer-agent-bridge/1.0',
  };
  if (auth) headers.Authorization = auth;
  if (!sec.WEBHOOK_AUTH && sec.WEBHOOK_KEY) headers['X-Automation-Key'] = sec.WEBHOOK_KEY;
  fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    .then(async (r) => {
      const t = (await r.text()).slice(0, 200);
      console.log(`HTTP ${r.status} from ${new URL(url).host}; response: ${redact(t)}`);
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(`request failed: ${e.message}`);
      process.exit(1);
    });
} else if (cmd === 'activity' && arg && /^[a-z0-9_]{1,32}$/.test(arg)) {
  const rest = process.argv.slice(4);
  const state = rest.shift() ?? 'show';
  const args: Record<string, unknown> = { state };
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, '');
    const v = rest[i + 1];
    if (!k || v === undefined || !['user', 'nick', 'channel', 'message', 'at'].includes(k)) {
      console.error(`bad option ${rest[i]}`);
      process.exit(2);
    }
    args[k] = k === 'at' ? Number(v) : v;
  }
  fetch(`http://127.0.0.1:${PORT}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bot: arg, command: 'activity', args }),
    signal: AbortSignal.timeout(5000),
  }).then(async (r) => {
    const t = await r.text();
    console.log(t);
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    console.error(`control endpoint unreachable: ${e.message}`);
    process.exit(1);
  });
} else if (cmd === 'post' && arg && /^[a-z0-9_]{1,32}$/.test(arg)) {
  post(arg, process.argv.slice(4)).then((code) => process.exit(code), (e) => { console.error(redact(String(e?.message ?? e))); process.exit(1); });
} else {
  console.error('usage: cli.js health | status | test-webhook <bot> | activity <bot> <responding|idle|show> [--user ID] [--nick NICK] [--channel ID] [--message ID] [--at MS]\n'
    + '       | post <bot> [--guild ID | --dm] [--reply-to ID] [--dry-run] <channel_id> <text...|->');
  process.exit(2);
}

/**
 * Post with the bot's own token (never printed). With --guild/--dm (or strict mode) the channel is resolved and another
 * guild is refused before any write. Sends typing, then the message. Prints the new message id.
 * Exit 3 = refused, 2 = usage, 1 = API error.
 */
async function post(bot: string, argv: string[]): Promise<number> {
  let guild: string | undefined, dm = false, replyTo: string | undefined, dry = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guild') guild = argv[++i];
    else if (a === '--dm') dm = true;
    else if (a === '--reply-to') replyTo = argv[++i];
    else if (a === '--dry-run') dry = true;
    else rest.push(a);
  }
  const [channel, ...words] = rest;
  let text = words.join(' ');
  if (words.length === 1 && words[0] === '-') text = fs.readFileSync(0, 'utf8').replace(/\n$/, '');
  if (!channel || (!text.trim() && !dry)) { console.error('usage: post <bot> [--guild ID | --dm] [--reply-to ID] [--dry-run] <channel_id> <text...|->'); return 2; }
  if (replyTo && !/^\d{5,25}$/.test(replyTo)) { console.error(`bad --reply-to ${replyTo}`); return 2; }
  let strict = truthy(process.env.FLUXER_REQUIRE_GUILD);
  try { strict ||= truthy((parseToml(fs.readFileSync(path.join(CFG_DIR, bot, 'bot.toml'), 'utf8')) as any).require_guild); } catch { /* no bot.toml: env only */ }
  const ctxv = parseCtx(guild, dm, process.env.FLUXER_CONTEXT_GUILD, strict);
  if (ctxv && 'error' in ctxv) { console.error(ctxv.error); return 3; }
  const token = parseEnvFile(fs.readFileSync(path.join(CFG_DIR, bot, 'secrets.env'), 'utf8')).FLUXER_BOT_TOKEN;
  if (!token) { console.error('FLUXER_BOT_TOKEN missing'); return 1; }
  const disc: any = await (await fetch(`${INSTANCE.replace(/\/$/, '')}/.well-known/fluxer`, { signal: AbortSignal.timeout(10000) })).json();
  const base = `${String(disc?.endpoints?.api ?? `${INSTANCE}/api`).replace(/\/$/, '')}/v1`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bot ${token}`, 'User-Agent': 'fluxer-agent-bridge/1.0', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  if (ctxv) {
    const refusal = await guard((p) => call('GET', p), channel, ctxv);
    if (refusal) { console.error(refusal); return 3; }
  }
  if (dry) { console.log(ctxv ? `ok (dry run): ${channel} matches ${'dm' in ctxv ? 'dm' : ctxv.guild}` : `ok (dry run): ${channel} (no guild check)`); return 0; }
  try { await call('POST', `/channels/${channel}/typing`, {}); } catch { /* best effort */ }
  const body: Record<string, unknown> = { content: text, nonce: String(process.hrtime.bigint()).slice(-18) };
  if (replyTo) body.message_reference = { message_id: replyTo, channel_id: channel };
  const m: any = await call('POST', `/channels/${channel}/messages`, body);
  console.log(m?.id ?? 'ok');
  return 0;
}
