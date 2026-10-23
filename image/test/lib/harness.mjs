// Runs webhook-forward against a fake gateway and a local HTTP receiver; returns the POSTed bodies (raw strings).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SELF = '100000000000000001', G = '100000000000000010';
export const CHANS = {
  '10': { id: '10', name: 'general', type: 0, guild_id: G },
  '20': { id: '20', name: 'bot-board', type: 15, guild_id: G, available_tags: [{ id: '31', name: 'Idea' }, { id: '32', name: 'Bug' }] },
  '21': { id: '21', name: 'tagged post', type: 11, parent_id: '20', guild_id: G, applied_tags: ['32', '31'] },
  '22': { id: '22', name: 'plain thread', type: 11, parent_id: '10', guild_id: G },
  '40': { id: '40', type: 1 },
};
const a = (id, bot = false, extra = {}) => ({ id, username: `u${id}`, global_name: null, bot, ...extra });

export async function run(plugin, extraConfig = {}) {
  const raw = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { raw.push(b); res.writeHead(200).end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const handlers = {};
  const ctx = {
    client: { rest: { get: async (p) => { const m = p.match(/^\/channels\/(\d+)$/); if (m && CHANS[m[1]]) return CHANS[m[1]]; if (p.startsWith('/guilds/')) return { name: 'Example Guild' }; throw new Error('404'); } }, guilds: new Map() },
    bot: { name: 'my_bot', owner: 'alice', userId: () => SELF, config: {} },
    config: { use: 'webhook-forward', mode: 'all', batch_seconds: 0.1, max_per_post: 50, events: ['reactions', 'member_join'], include_dms: true, ...extraConfig },
    secrets: { WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/hook`, WEBHOOK_AUTH: 'Bearer test' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bbtest-')),
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn)), onSessionStart() {}, command() {}, emit() {},
    health: { degrade() {}, clear() {}, setNote() {} }, status() {},
  };
  const inst = await plugin.setup(ctx);
  const fire = async (ev, d) => { for (const f of handlers[ev] ?? []) await f(d, { t: ev, s: 1, d }); };
  const T = '2026-10-19T10:00:00.000Z';
  await fire('MESSAGE_CREATE', { id: '500', channel_id: '10', guild_id: G, author: a(SELF, true), content: 'mine', timestamp: T });
  await fire('MESSAGE_CREATE', { id: '501', channel_id: '10', guild_id: G, author: a('900', false, { global_name: 'Zee' }), member: { nick: 'Z' }, content: 'hello', timestamp: T });
  await fire('MESSAGE_CREATE', { id: '502', channel_id: '10', guild_id: G, author: a('901'), content: 'reply to bot', timestamp: T,
    message_reference: { message_id: '500', channel_id: '10', guild_id: G }, referenced_message: { id: '500', author: a(SELF, true), content: 'mine' } });
  await fire('MESSAGE_CREATE', { id: '503', channel_id: '21', guild_id: G, author: a('900'), content: 'in a tagged forum post', timestamp: T,
    attachments: [{ url: 'https://x/a.png', filename: 'a.png', content_type: 'image/png', size: 10 }] });
  await fire('MESSAGE_CREATE', { id: '504', channel_id: '22', guild_id: G, author: a('900'), content: 'in a plain thread', timestamp: T });
  await fire('MESSAGE_CREATE', { id: '505', channel_id: '40', author: a('902'), content: 'a dm', timestamp: T });
  await fire('MESSAGE_UPDATE', { id: '501', channel_id: '10', guild_id: G, author: a('900'), content: 'hello (edited)', timestamp: T, edited_timestamp: T });
  await fire('MESSAGE_DELETE', { id: '504', channel_id: '22', guild_id: G });
  await fire('MESSAGE_REACTION_ADD', { user_id: '900', channel_id: '10', message_id: '500', guild_id: G, emoji: { name: '👍' }, member: { nick: 'Z', user: a('900') } });
  await fire('GUILD_MEMBER_ADD', { guild_id: G, user: a('903'), nick: null, roles: [] });
  await new Promise((r) => setTimeout(r, 800));
  inst.teardown(); srv.close();
  return raw;
}
/** Make non-message event ids/timestamps deterministic so two runs can be compared byte for byte. */
export const normalize = (s) => s.replace(/"(reaction_add|member_join):\d+:\d+"/g, '"$1:T:N"').replace(/"timestamp":"\d{4}-[^"]+"/g, '"timestamp":"T"');
