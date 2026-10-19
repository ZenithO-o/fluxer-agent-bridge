// Plugin-level test: fake gateway dispatches -> real batching/outbox -> local HTTP webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/plugins/webhook-forward.js';

const SELF = '100000000000000001', G = '100000000000000010';
test('mode all: batches every message except own, tags reasons, forwards edits/deletes, honours ignore', async () => {
  const posts = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { posts.push({ h: req.headers, body: JSON.parse(b) }); res.writeHead(200).end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const handlers = {}; let status; const emitted = [];
  const chans = { '10': { id: '10', name: 'general', type: 0, guild_id: G }, '11': { id: '11', name: 'trip-planning', type: 0, guild_id: G },
    '12': { id: '12', name: 'muted', type: 0, guild_id: G }, '13': { id: '13', name: 'plan', type: 11, parent_id: '11', guild_id: G } };
  const ctx = {
    client: { rest: { get: async (p) => { const m = p.match(/^\/channels\/(\d+)$/); if (m) return chans[m[1]]; if (p.startsWith('/guilds/')) return { name: 'Example Guild' }; throw new Error('404'); } }, guilds: new Map() },
    bot: { name: 'my_bot', owner: 'alice', userId: () => SELF, config: {} },
    config: { use: 'webhook-forward', mode: 'all', batch_seconds: 0.2, max_per_post: 3, ignore: { channels: ['12'] }, events: ['reactions', 'member_join', 'member_leave', 'thread_create'] },
    secrets: { WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/hook`, WEBHOOK_AUTH: 'Bearer test' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bbtest-')),
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn)), onSessionStart() {}, command() {}, emit: (ev, d) => emitted.push([ev, d]),
    health: { degrade() {}, clear() {}, setNote() {} }, status: (fn) => (status = fn),
  };
  const inst = await plugin.setup(ctx);
  const fire = async (ev, d) => { for (const f of handlers[ev] ?? []) await f(d, { t: ev, s: 1, d }); };
  const a = (id, bot = false) => ({ id, username: `u${id}`, bot });
  await fire('MESSAGE_CREATE', { id: '100', channel_id: '10', guild_id: G, author: a(SELF, true), content: 'my own' });
  await fire('MESSAGE_CREATE', { id: '101', channel_id: '11', guild_id: G, author: a('100000000000000002', true), content: 'hi from other_bot' });
  await fire('MESSAGE_CREATE', { id: '102', channel_id: '10', guild_id: G, author: a('900'), content: 'reply', message_reference: { message_id: '100', channel_id: '10' } });
  await fire('MESSAGE_CREATE', { id: '103', channel_id: '12', guild_id: G, author: a('900'), content: 'ignored' });
  await fire('MESSAGE_CREATE', { id: '104', channel_id: '12', guild_id: G, author: a('900'), content: 'ping', mentions: [{ id: SELF }] });
  await fire('MESSAGE_CREATE', { id: '105', channel_id: '13', guild_id: G, author: a('900'), content: 'in thread' });
  await fire('MESSAGE_UPDATE', { id: '101', channel_id: '11', guild_id: G, author: a('100000000000000002', true), content: 'edited', edited_timestamp: 'x' });
  await fire('MESSAGE_DELETE', { id: '105', channel_id: '13', guild_id: G });
  await fire('MESSAGE_DELETE', { id: '100', channel_id: '10', guild_id: G });
  await new Promise((r) => setTimeout(r, 1500));
  const before = posts.flatMap((p) => p.body.messages).length;
  await fire('MESSAGE_REACTION_ADD', { user_id: '900', channel_id: '10', message_id: '100', guild_id: G, emoji: { name: '👍' }, member: { nick: 'Zee', user: a('900') } });
  await fire('MESSAGE_REACTION_ADD', { user_id: SELF, channel_id: '10', message_id: '102', guild_id: G, emoji: { name: '👍' } });
  await fire('MESSAGE_REACTION_REMOVE', { user_id: '900', channel_id: '11', message_id: '101', guild_id: G, emoji: { name: '👍' } });
  await fire('GUILD_MEMBER_ADD', { guild_id: G, user: a('901'), nick: null, roles: [] });
  await fire('GUILD_MEMBER_REMOVE', { guild_id: G, user: a('902') });
  await fire('GUILD_MEMBER_UPDATE', { guild_id: G, user: a('901'), nick: 'x', roles: [] });
  await fire('CHANNEL_CREATE', { id: '14', name: 'new-thread', type: 11, parent_id: '11', guild_id: G, owner_id: '900' });
  await fire('CHANNEL_CREATE', { id: '15', name: 'new-chan', type: 0, guild_id: G });
  await fire('TYPING_START', { channel_id: '10', guild_id: G, user_id: '900' });
  await new Promise((r) => setTimeout(r, 1500));
  inst.teardown(); srv.close();
  const items = posts.flatMap((p) => p.body.messages);
  assert.ok(posts.length >= 2, 'batched into several POSTs (max_per_post=3)');
  assert.ok(posts.every((p) => p.body.messages.length <= 3 && p.h.authorization === 'Bearer test' && p.h['idempotency-key']));
  assert.deepEqual(items.slice(0, before).map((i) => `${i.event}:${i.id}:${i.reason}`),
    ['create:101:all', 'create:102:reply-to-bot', 'create:104:ping', 'create:105:all', 'edit:101:all', 'delete:105:all']);
  const evs = items.slice(before);
  assert.deepEqual(evs.map((i) => `${i.event}:${i.reason}`), ['reaction_add:reaction-to-bot', 'reaction_remove:all', 'member_join:all', 'member_leave:all', 'thread_create:all']);
  assert.equal(evs[0].author.display_name, 'Zee'); assert.equal(evs[0].emoji.name, '👍'); assert.equal(evs[0].message_id, '100'); assert.equal(evs[0].legacy_reason, 'reaction');
  assert.equal(evs[2].user.id, '901'); assert.equal(evs[4].channel.id, '14'); assert.equal(evs[4].channel_name, 'trip-planning > new-thread');
  assert.ok(emitted.length >= 2 && emitted.every(([ev, d]) => ev === 'bb:delivered' && d.status === 200 && d.items.length));
  const t = items.find((i) => i.id === '105' && i.event === 'create');
  assert.equal(t.thread.parent_id, '11'); assert.equal(t.channel_name, 'trip-planning > plan'); assert.equal(t.parent_channel_id, '11');
  const n = items.find((i) => i.id === '101'); assert.equal(n.author.bot, true); assert.equal(n.legacy_reason, 'all'); assert.equal(n.guild_name, 'Example Guild');
  assert.equal(items.find((i) => i.id === '102').reference.message_id, '100');
  assert.equal(items.find((i) => i.id === '104').legacy_reason, 'mention');
  const s = status();
  assert.equal(s.forwarded, 11); assert.equal(s.filtered_by['reaction_add:self'], 1); assert.equal(s.filtered_by.self, 2); assert.equal(s.filtered_by['ignore.channels'], 1);
  assert.equal(s.queued_by_reason.all, 8);
});
