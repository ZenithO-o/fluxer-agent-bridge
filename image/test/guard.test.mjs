// Fail-closed guild pinning used by `cli.js post`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, guard, parseCtx } from '../dist/guard.js';

const G = '100000000000000010', H = '100000000000000099';
const chans = { '1000000001': { id: '1000000001', type: 0, guild_id: G }, '1000000002': { id: '1000000002', type: 11, parent_id: '1000000001' },
  '1000000003': { id: '1000000003', type: 1 }, '1000000004': { id: '1000000004', type: 11, guild_id: H, parent_id: '1000000009' } };
const calls = []; const get = async (p) => { calls.push(p); const c = chans[p.split('/').pop()]; if (!c) throw new Error('404'); return c; };

test('parseCtx: no context = no check (strict refuses); dm and guild are exclusive; env is a fallback; "dm" copies', () => {
  assert.equal(parseCtx(undefined, false, undefined), null);
  assert.match(parseCtx(undefined, false, undefined, true).error, /no context guild \(strict/);
  assert.deepEqual(parseCtx(undefined, false, G, true), { guild: G }, 'env context satisfies strict');
  assert.match(parseCtx(G, true).error, /not both/);
  assert.match(parseCtx('abc').error, /bad guild/);
  assert.deepEqual(parseCtx(undefined, false, G), { guild: G });
  assert.deepEqual(parseCtx('dm'), { dm: true });
  assert.deepEqual(parseCtx(undefined, false, 'dm'), { dm: true });
  assert.deepEqual(parseCtx(G, false, H), { guild: G }, 'explicit beats env');
});

test('guard: same guild ok, threads inherit, other guild / unknown / DM mismatch refused', async () => {
  assert.equal(await guard(get, '1000000001', { guild: G }), null);
  assert.equal(await guard(get, '1000000002', { guild: G }), null, 'thread resolves through its parent');
  assert.match(await guard(get, '1000000004', { guild: G }), /is in guild 100000000000000099, context is 100000000000000010/);
  assert.match(await guard(get, '1000000005', { guild: G }), /not resolvable/);
  assert.match(await guard(get, '1000000003', { guild: G }), /has no guild/);
  assert.equal(await guard(get, '1000000003', { dm: true }), null);
  assert.match(await guard(get, '1000000001', { dm: true }), /not a DM/);
  assert.match(await guard(get, '12;rm', { guild: G }), /bad channel id/);
  assert.ok(calls.every((p) => p.startsWith('/channels/')), 'only reads');
  assert.match(checkTarget('1', null, { guild: G }), /not resolvable/);
});
