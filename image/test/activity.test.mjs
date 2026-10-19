// activity-status state machine + plugin wiring (fake ctx, fake clock where needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityMachine } from '../dist/plugins/activity-machine.js';
import plugin from '../dist/plugins/activity-status.js';

const T = { readingMs: 120000, respondingMs: 120000, respondedMs: 20000 };
test('reading texts: one message, several from one author, multiple authors; merge + expiry', () => {
  let now = 0; const m = new ActivityMachine(T, () => now);
  assert.equal(m.view().text, null);
  m.reading([{ authorId: '1', nick: 'Alice' }]); assert.equal(m.view().text, "Reading Alice's message");
  now = 1000; m.reading([{ authorId: '1', nick: 'Alice' }]); assert.equal(m.view().text, "Reading Alice's messages");
  m.reading([{ authorId: '2', nick: 'Bob' }]); assert.equal(m.view().text, 'Reading multiple messages');
  now = 1000 + 120000; assert.equal(m.view().state, 'idle'); assert.equal(m.view().text, null);
  m.reading([{ authorId: '2', nick: 'Bob' }]); assert.equal(m.view().text, "Reading Bob's message", 'new window after idle');
});
test('responding -> responded -> idle; responding is sticky against new reads; stale command ignored', () => {
  let now = 0; const m = new ActivityMachine(T, () => now);
  m.reading([{ authorId: '1', nick: 'Alice' }]);
  assert.equal(m.responding(null).applied, true); assert.equal(m.view().text, "Responding to Alice's message", 'falls back to reading nick');
  assert.equal(m.reading([{ authorId: '2', nick: 'Bob' }]), false); assert.equal(m.view().state, 'responding');
  now = 5000; m.responded(null); assert.equal(m.view().text, "Responded to Alice's message", 'falls back to last Responding nick');
  assert.equal(m.responding('X', 4000).applied, false, 'issued before the reply landed');
  now = 25000; assert.equal(m.view().state, 'idle');
  m.responding('Bob', 26000); assert.equal(m.view().text, "Responding to Bob's message");
  now = 26000 + 120000; assert.equal(m.view().state, 'idle', 'responding times out');
  m.responded('Kit'); assert.equal(m.view().text, "Responded to Kit's message");
  m.responding(null); assert.equal(m.view().text, 'Responding to a message');
});

test('plugin: delivered -> Reading, typing/control -> Responding, own message -> Responded, presence coalescing config', async () => {
  const SELF = 's1', handlers = {}, controls = {}; let activity = 'unset', rate = null;
  const ctx = {
    client: { rest: { get: async (p) => { if (p === '/channels/c1/messages/m9') return { id: 'm9', author: { id: 'u9', username: 'kit' } }; if (p.includes('/members/u9')) return { nick: 'Kitty', user: { id: 'u9' } }; if (p.startsWith('/channels/')) return { guild_id: 'g' }; throw new Error('404'); } }, guilds: new Map([['g', {}]]) },
    bot: { name: 'my_bot', owner: 'alice', userId: () => SELF, config: {} },
    config: { use: 'activity-status', responded_seconds: 0.3, min_update_seconds: 2 },
    secrets: {}, log: { info() {}, warn() {}, error() {}, debug() {} }, stateDir: '/tmp',
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn)), onSessionStart() {}, command() {}, emit() {},
    control: (n, fn) => (controls[n] = fn), health: { degrade() {}, clear() {}, setNote() {} }, status() {},
    presence: { setActivity: (t) => (activity = t), setRate: (g, n) => (rate = [g, n]), current: () => ({ status: 'online', text: activity }) },
  };
  const inst = await plugin.setup(ctx);
  const fire = async (ev, d) => { for (const f of handlers[ev] ?? []) await f(d, { t: ev, s: 1, d }); };
  assert.deepEqual(rate, [2000, 12]); assert.equal(activity, null);
  await fire('MESSAGE_CREATE', { id: 'm1', channel_id: 'c1', author: { id: 'u1', username: 'alice', global_name: 'Alice G' }, member: { nick: 'Alice' } });
  await fire('bb:delivered', { status: 200, items: [{ event: 'create', id: 'm1', author: { id: 'u1', username: 'alice', global_name: 'Alice G', nick: 'Alice' } }] });
  assert.equal(activity, "Reading Alice's message");
  await fire('bb:delivered', { status: 200, items: [{ event: 'reaction_add', id: 'x', author: { id: 'u2' } }] });
  assert.equal(activity, "Reading Alice's message", 'non-message events do not change Reading');
  await fire('TYPING_START', { channel_id: 'c1', user_id: 'u1' }); assert.equal(activity, "Reading Alice's message", 'others typing is ignored');
  await fire('TYPING_START', { channel_id: 'c1', user_id: SELF }); assert.equal(activity, "Responding to Alice's message");
  const r = await controls.activity({ state: 'idle' }); assert.equal(r.state, 'idle');
  const r2 = await controls.activity({ state: 'responding', channel: 'c1', message: 'm9' });
  assert.equal(r2.applied, true); assert.equal(activity, "Responding to Kitty's message", 'nick resolved via REST member');
  await fire('MESSAGE_CREATE', { id: 'm10', channel_id: 'c1', author: { id: SELF, bot: true }, message_reference: { message_id: 'm9', channel_id: 'c1' } });
  assert.equal(activity, "Responded to Kitty's message");
  const r3 = await controls.activity({ state: 'responding', channel: 'c1', message: 'm9' });
  assert.equal(r3.applied, false, 'late command for an already-answered message is ignored');
  await new Promise((res) => setTimeout(res, 450));
  assert.equal(activity, null, 'back to idle after responded_seconds');
  inst.teardown();
});
