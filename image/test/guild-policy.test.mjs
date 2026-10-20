// Per-guild forward policy end to end: [guilds."<id>"] forward = "mentions" through webhook-forward (live + backfill).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/plugins/webhook-forward.js';

const SELF = '100000000000000001', PUB = '1561622443464851456', INTERNAL = '1561216435596820481';
const EMOJI = '1561987178181951488';
const CH = { '70': { id: '70', name: 'public-chat', type: 0, guild_id: PUB, last_message_id: '99' }, '80': { id: '80', name: 'internal', type: 0, guild_id: INTERNAL },
  [EMOJI]: { id: EMOJI, name: 'add-emojis', type: 0, guild_id: PUB }, '75': { id: '75', name: 'add-emojis-thread', type: 11, guild_id: PUB, parent_id: EMOJI } };
const MSGS = { '70/10': { id: '10', channel_id: '70', author: { id: SELF, bot: true }, content: 'bot said' }, '70/11': { id: '11', channel_id: '70', author: { id: '901' }, content: 'other said' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (id) => ({ id, username: `u${id}` });

async function start({ backfill = [], guilds = { [PUB]: { forward: 'mentions' } } } = {}) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(...JSON.parse(b).messages); res.writeHead(200).end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbguild-'));
  if (backfill.length) fs.writeFileSync(path.join(stateDir, 'cursors.json'), JSON.stringify({ channels: { '70': '1' } }));
  const handlers = {}; let session; let status;
  const rest = { get: async (p) => {
    let m;
    if ((m = p.match(/^\/channels\/(\d+)$/)) && CH[m[1]]) return CH[m[1]];
    if ((m = p.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && MSGS[`${m[1]}/${m[2]}`]) return MSGS[`${m[1]}/${m[2]}`];
    if (p.startsWith('/channels/70/messages?after=')) return backfill;
    if (p === `/guilds/${PUB}/channels`) return [CH['70']];
    if (p.startsWith('/guilds/')) return { name: 'G', roles: [] };
    throw new Error('404');
  } };
  const ctx = {
    client: { rest, guilds: new Map(backfill.length ? [[PUB, {}]] : []) },
    bot: { name: 'zenith_bot', owner: 'zenith', userId: () => SELF, config: { guilds } },
    config: { use: 'webhook-forward', mode: 'all', batch_seconds: 0.05, events: ['reactions', 'members', 'threads'] },
    secrets: { WEBHOOK_URL: `http://127.0.0.1:${srv.address().port}/hook`, WEBHOOK_AUTH: 'Bearer t' },
    log: { info() {}, warn() {}, error() {}, debug() {} }, stateDir,
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn)), onSessionStart: (fn) => (session = fn), command() {}, emit() {},
    health: { degrade() {}, clear() {}, setNote() {} }, status: (fn) => (status = fn),
  };
  const inst = await plugin.setup(ctx);
  const fire = async (ev, d) => { for (const f of handlers[ev] ?? []) await f(d, { t: ev, s: 1, d }); };
  return { got, fire, session: () => session(), status: () => status(), stop: async () => { await inst.teardown(); srv.close(); }, stateDir };
}

test('live: mentions guild forwards only structured mentions and replies to the bot; edits/deletes follow; other guilds unchanged', async () => {
  const b = await start();
  const P = (id, over = {}) => ({ id, channel_id: '70', guild_id: PUB, author: u('900'), mentions: [], content: 'x', timestamp: 'T', ...over });
  await b.fire('MESSAGE_CREATE', P('20', { mentions: [{ id: SELF }], content: '<@1> hi' }));                          // mention -> ping
  await b.fire('MESSAGE_CREATE', P('21', { content: '@zenith_bot are you there?' }));                                // text only -> dropped
  await b.fire('MESSAGE_CREATE', P('22', { message_reference: { message_id: '10', channel_id: '70' } }));             // reply, referenced_message missing -> REST lookup -> bot
  await b.fire('MESSAGE_CREATE', P('23', { message_reference: { message_id: '11', channel_id: '70' } }));             // reply to someone else -> dropped
  await b.fire('MESSAGE_UPDATE', P('20', { content: 'edited', edited_timestamp: 'E1' }));                             // edit of qualifying -> forwarded
  await b.fire('MESSAGE_UPDATE', P('21', { content: 'edited', edited_timestamp: 'E2', mentions: [{ id: SELF }] }));   // edit of non-qualifying -> dropped
  await b.fire('GUILD_MEMBER_ADD', { guild_id: PUB, user: u('905'), roles: [] });                                     // join -> dropped
  await b.fire('MESSAGE_REACTION_ADD', { user_id: '900', channel_id: '70', message_id: '10', guild_id: PUB, emoji: { name: 'x' }, message_author_id: SELF }); // reaction on bot, sub-option off -> dropped
  await b.fire('MESSAGE_DELETE', { id: '20', channel_id: '70', guild_id: PUB });                                     // delete of qualifying -> forwarded
  await b.fire('MESSAGE_DELETE', { id: '23', channel_id: '70', guild_id: PUB });                                     // delete of non-qualifying -> dropped
  await b.fire('MESSAGE_CREATE', { id: '30', channel_id: '80', guild_id: INTERNAL, author: u('900'), content: 'internal chatter', timestamp: 'T' }); // unconfigured -> all
  await b.fire('GUILD_MEMBER_ADD', { guild_id: INTERNAL, user: u('906'), roles: [] });                                // unconfigured join -> all
  await sleep(500); await b.stop();
  assert.deepEqual(b.got.map((m) => `${m.event}:${m.event === 'member_join' ? m.user.id : m.id}:${m.reason}`),
    ['create:20:ping', 'create:22:reply-to-bot', 'edit:20:ping', 'delete:20:all', 'create:30:all', 'member_join:906:all']);
  const keys = ['event', 'id', 'channel_id', 'channel_name', 'guild_id', 'guild_name', 'is_dm', 'author', 'timestamp', 'edited_timestamp', 'content', 'attachments', 'reply_to', 'reference', 'thread', 'parent_channel_id', 'reason', 'legacy_reason', 'dedupe_key'];
  assert.deepEqual(Object.keys(b.got[0]), keys, 'payload shape unchanged');
  assert.equal(b.got[0].legacy_reason, 'mention'); assert.equal(b.got[1].legacy_reason, 'reply');
  assert.ok(JSON.parse(fs.readFileSync(path.join(b.stateDir, 'qualified.json'), 'utf8')).ids.some(([i]) => i === '20'), 'qualified ids persisted');
});

test('backfill applies the same filter', async () => {
  const b = await start({ backfill: [
    { id: '41', channel_id: '70', author: u('900'), mentions: [{ id: SELF }], content: 'missed ping', timestamp: 'T' },
    { id: '42', channel_id: '70', author: u('900'), mentions: [], content: '@zenith_bot missed text', timestamp: 'T' },
    { id: '43', channel_id: '70', author: u('900'), mentions: [], content: 'chatter', timestamp: 'T' },
  ] });
  await b.session(); await sleep(400); await b.stop();
  assert.deepEqual(b.got.map((m) => `${m.id}:${m.reason}:${m.backfill === true}`), ['41:ping:true']);
  assert.equal(b.status().filtered_by['guild.mentions'], 2);
});

test('per-channel: #add-emojis forward = "all" inside the mentions guild; threads inherit; other channels stay mentions-only', async () => {
  const b = await start({ guilds: { [PUB]: { forward: 'mentions', channels: { [EMOJI]: { forward: 'all' } } } } });
  const P = (id, ch, over = {}) => ({ id, channel_id: ch, guild_id: PUB, author: u('900'), mentions: [], content: 'x', timestamp: 'T', ...over });
  await b.fire('MESSAGE_CREATE', P('50', EMOJI, { content: 'please add https://emoji.gg/emoji/1-x' }));   // channel all -> all
  await b.fire('MESSAGE_CREATE', P('51', '75'));                                                        // thread under #add-emojis -> all
  await b.fire('MESSAGE_CREATE', P('52', '70'));                                                        // #public-chat chatter -> dropped
  await b.fire('MESSAGE_CREATE', P('53', '70', { mentions: [{ id: SELF }] }));                          // #public-chat mention -> ping
  await b.fire('MESSAGE_UPDATE', P('50', EMOJI, { content: 'edited', edited_timestamp: 'E1' }));        // edit in channel all -> all
  await b.fire('MESSAGE_UPDATE', P('52', '70', { content: 'edited', edited_timestamp: 'E2' }));         // edit of dropped -> dropped
  await b.fire('MESSAGE_REACTION_ADD', { user_id: '900', channel_id: EMOJI, message_id: '50', guild_id: PUB, emoji: { name: 'x' } }); // reaction in channel all -> all
  await b.fire('GUILD_MEMBER_ADD', { guild_id: PUB, user: u('905'), roles: [] });                       // guild-wide event -> guild policy (dropped)
  await b.fire('MESSAGE_DELETE', { id: '50', channel_id: EMOJI, guild_id: PUB });                       // delete in channel all -> all
  await sleep(500); await b.stop();
  assert.deepEqual(b.got.map((m) => `${m.event}:${m.event.startsWith('reaction') ? m.message_id : m.id}:${m.reason}`),
    ['create:50:all', 'create:51:all', 'create:53:ping', 'edit:50:all', 'reaction_add:50:all', 'delete:50:all']);
  const q = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'qualified.json'), 'utf8')).ids.map(([i]) => i);
  assert.deepEqual(q, ['53'], 'only mentions-policy messages are tracked as qualified');
  assert.equal(b.got[1].parent_channel_id, EMOJI);
  assert.equal(b.status().filtered_by['guild.mentions'], 2);
});
