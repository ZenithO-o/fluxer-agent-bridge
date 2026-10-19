// Unit tests for the webhook-forward filter: `npm test` (builds, then node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { decideMessage, decideDelete, decideEvent, parseEvents, nickOf, parseIgnore, toIdSet, BoundedMap } from '../dist/plugins/forward-filter.js';

const SELF = '100000000000000001', OTHERBOT = '100000000000000002', USER = '900', G = '100000000000000010';
const HOME = '100000000000000020', OTHERCH = '100000000000000030', GENERAL = '111', THREAD = '222';
const opts = (over = {}) => ({ mode: 'all', selfId: SELF, home: new Set([HOME]), allow: new Set(), deny: new Set(), skipAuthors: new Set(['self']),
  includeDms: true, includeBots: true, everyoneIsPing: false, myRoles: new Set(['r1']), ownMessageIds: new Set(['own1']),
  ignore: parseIgnore({}), ...over });
const msg = (over = {}) => ({ id: '5', channel_id: GENERAL, guild_id: G, author: { id: USER, bot: false }, mentions: [], ...over });
const reason = (d) => (d.forward ? d.reason : `DROP:${d.why}`);

test('mode all forwards ordinary messages from any channel', () => {
  assert.equal(reason(decideMessage(msg(), null, opts())), 'all');
  assert.equal(reason(decideMessage(msg({ channel_id: OTHERCH }), null, opts())), 'all');
});
test('own messages are never forwarded', () => {
  assert.equal(reason(decideMessage(msg({ author: { id: SELF, bot: true } }), null, opts())), 'DROP:self');
});
test('other bots are forwarded (other_bot -> my_bot)', () => {
  assert.equal(reason(decideMessage(msg({ author: { id: OTHERBOT, bot: true } }), null, opts())), 'all');
});
test('reasons: ping, reply-to-bot (referenced_message and message_reference), home', () => {
  assert.equal(reason(decideMessage(msg({ mentions: [{ id: SELF }] }), null, opts())), 'ping');
  assert.equal(reason(decideMessage(msg({ mention_roles: ['r1'] }), null, opts())), 'ping');
  assert.equal(reason(decideMessage(msg({ referenced_message: { id: 'x', author: { id: SELF } } }), null, opts())), 'reply-to-bot');
  assert.equal(reason(decideMessage(msg({ message_reference: { message_id: 'own1' } }), null, opts())), 'reply-to-bot');
  assert.equal(reason(decideMessage(msg({ message_reference: { message_id: 'other' } }), null, opts())), 'all');
  assert.equal(reason(decideMessage(msg({ channel_id: HOME }), null, opts())), 'home');
  assert.equal(reason(decideMessage(msg({ channel_id: THREAD }), HOME, opts())), 'home', 'thread inherits home from parent');
  assert.equal(reason(decideMessage(msg({ mention_everyone: true }), null, opts())), 'all');
  assert.equal(reason(decideMessage(msg({ mention_everyone: true }), null, opts({ everyoneIsPing: true }))), 'ping');
});
test('legacy modes keep working', () => {
  assert.equal(reason(decideMessage(msg(), null, opts({ mode: 'pings-and-home' }))), 'DROP:mode');
  assert.equal(reason(decideMessage(msg({ channel_id: HOME }), null, opts({ mode: 'pings-and-home' }))), 'home');
  assert.equal(reason(decideMessage(msg({ channel_id: HOME }), null, opts({ mode: 'pings-only' }))), 'DROP:mode');
  assert.equal(reason(decideMessage(msg({ mentions: [{ id: SELF }] }), null, opts({ mode: 'pings-only' }))), 'ping');
  assert.equal(reason(decideMessage(msg({ author: { id: OTHERBOT, bot: true } }), null, opts({ includeBots: false }))), 'DROP:include_bots=false');
});
test('ignore list drops ambient traffic but lets pings/replies through unless strict', () => {
  const ig = parseIgnore({ channels: [OTHERCH], users: ['777'], bots: true });
  assert.equal(reason(decideMessage(msg({ channel_id: OTHERCH }), null, opts({ ignore: ig }))), 'DROP:ignore.channels');
  assert.equal(reason(decideMessage(msg({ channel_id: THREAD }), OTHERCH, opts({ ignore: ig }))), 'DROP:ignore.channels', 'parent covers threads');
  assert.equal(reason(decideMessage(msg({ channel_id: OTHERCH, mentions: [{ id: SELF }] }), null, opts({ ignore: ig }))), 'ping');
  assert.equal(reason(decideMessage(msg({ channel_id: OTHERCH, message_reference: { message_id: 'own1' } }), null, opts({ ignore: ig }))), 'reply-to-bot');
  assert.equal(reason(decideMessage(msg({ author: { id: '777' } }), null, opts({ ignore: ig }))), 'DROP:ignore.users');
  assert.equal(reason(decideMessage(msg({ author: { id: OTHERBOT, bot: true } }), null, opts({ ignore: ig }))), 'DROP:ignore.bots');
  assert.equal(reason(decideMessage(msg({ author: { id: OTHERBOT, bot: true }, mentions: [{ id: SELF }] }), null, opts({ ignore: ig }))), 'ping');
  const strict = parseIgnore({ channels: [OTHERCH], strict: true });
  assert.equal(reason(decideMessage(msg({ channel_id: OTHERCH, mentions: [{ id: SELF }] }), null, opts({ ignore: strict }))), 'DROP:ignore.channels');
});
test('skip_channels stays a hard drop', () => {
  assert.equal(reason(decideMessage(msg({ mentions: [{ id: SELF }] }), null, opts({ deny: new Set([GENERAL]) }))), 'DROP:skip_channels');
});
test('deletes', () => {
  assert.equal(reason(decideDelete({ channel_id: GENERAL, guild_id: G }, null, null, opts())), 'all');
  assert.equal(reason(decideDelete({ channel_id: HOME, guild_id: G }, null, null, opts())), 'home');
  assert.equal(reason(decideDelete({ channel_id: GENERAL, guild_id: G }, null, { id: SELF, bot: true }, opts())), 'DROP:self');
  assert.equal(reason(decideDelete({ channel_id: OTHERCH, guild_id: G }, null, null, opts({ ignore: parseIgnore({ channels: [OTHERCH] }) }))), 'DROP:ignore.channels');
  assert.equal(reason(decideDelete({ channel_id: GENERAL, guild_id: G }, null, null, opts({ mode: 'pings-only' }))), 'DROP:mode');
});
test('bot.toml [plugins.ignore] sub-table attaches to the preceding [[plugins]] entry', () => {
  const t = parse(`
[[plugins]]
use = "ping"
[[plugins]]
use = "webhook-forward"
mode = "all"
[plugins.ignore]
channels = ["${OTHERCH}"]
users = []
bots = false
strict = false
`);
  assert.equal(t.plugins[0].ignore, undefined);
  const ig = parseIgnore(t.plugins[1].ignore);
  assert.deepEqual([...ig.channels], [OTHERCH]);
  assert.equal(ig.bots, false); assert.equal(ig.strict, false);
  assert.deepEqual([...parseIgnore(undefined).channels], []);
  assert.deepEqual([...toIdSet('a, b,,c')], ['a', 'b', 'c']);
});
test('BoundedMap evicts oldest', () => {
  const b = new BoundedMap(2); b.set('a', 1); b.set('b', 2); b.set('c', 3);
  assert.equal(b.has('a'), false); assert.deepEqual(b.keys(), ['b', 'c']);
});

test('events: aliases, unknown names, reasons and ignore handling', () => {
  const { kinds, unknown } = parseEvents(['reactions', 'member_join', 'member-leave', 'thread_create', 'bogus']);
  assert.deepEqual([...kinds].sort(), ['member_join', 'member_leave', 'reaction_add', 'reaction_remove', 'thread_create']);
  assert.deepEqual(unknown, ['bogus']);
  assert.equal(parseEvents(undefined).kinds.size, 0, 'off by default');
  const e = (over = {}) => ({ channelId: GENERAL, parentId: null, guildId: G, actor: { id: USER, bot: false }, toBot: false, ...over });
  assert.equal(reason(decideEvent('reaction_add', e(), opts())), 'all');
  assert.equal(reason(decideEvent('reaction_add', e({ toBot: true }), opts())), 'reaction-to-bot');
  assert.equal(reason(decideEvent('reaction_add', e({ actor: { id: SELF, bot: true } }), opts())), 'DROP:self');
  assert.equal(reason(decideEvent('typing', e({ channelId: HOME }), opts())), 'home');
  assert.equal(reason(decideEvent('member_join', e({ channelId: null }), opts())), 'all');
  const ig = parseIgnore({ channels: [GENERAL], users: ['777'] });
  assert.equal(reason(decideEvent('reaction_add', e(), opts({ ignore: ig }))), 'DROP:ignore.channels');
  assert.equal(reason(decideEvent('reaction_add', e({ toBot: true }), opts({ ignore: ig }))), 'reaction-to-bot');
  assert.equal(reason(decideEvent('member_join', e({ channelId: null, actor: { id: '777', bot: false } }), opts({ ignore: ig }))), 'DROP:ignore.users');
});
test('nickOf: guild nick > global name > username', () => {
  assert.equal(nickOf({ username: 'u', global_name: 'G' }, { nick: 'N' }), 'N');
  assert.equal(nickOf({ username: 'u', global_name: 'G' }), 'G');
  assert.equal(nickOf({ username: 'u' }), 'u');
  assert.equal(nickOf({ username: 'u', global_name: 'G', nick: 'N2' }), 'N2', 'forwarded author objects carry nick');
});
