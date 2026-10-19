// At-least-once delivery: drain on stop, redelivery after an unanswered POST, and a persisted ring of 2xx'd keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../dist/plugins/webhook-forward.js';
import { SELF, G, CHANS } from './lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Receiver whose answer per request is decided by `behave(n)`: a delay in ms, or 'hang'. */
async function receiver(behave) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { const n = reqs.push({ h: req.headers, body: JSON.parse(b) }); const d = behave(n); if (d !== 'hang') setTimeout(() => res.writeHead(200).end('{}'), d); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { reqs, url: `http://127.0.0.1:${srv.address().port}/hook`, close: () => { srv.closeAllConnections(); srv.close(); } };
}

async function start(url, stateDir, extra = {}) {
  const handlers = {}; let status;
  const ctx = {
    client: { rest: { get: async (p) => { const m = p.match(/^\/channels\/(\d+)$/); if (m && CHANS[m[1]]) return CHANS[m[1]]; if (p.startsWith('/guilds/')) return { name: 'Example Guild' }; throw new Error('404'); } }, guilds: new Map() },
    bot: { name: 'my_bot', owner: 'alice', userId: () => SELF, config: {} },
    config: { use: 'webhook-forward', mode: 'all', batch_seconds: 0.05, ...extra },
    secrets: { WEBHOOK_URL: url, WEBHOOK_AUTH: 'Bearer test' },
    log: { info() {}, warn() {}, error() {}, debug() {} }, stateDir,
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn)), onSessionStart() {}, command() {}, emit() {},
    health: { degrade() {}, clear() {}, setNote() {} }, status: (fn) => (status = fn),
  };
  const inst = await plugin.setup(ctx);
  const fire = async (ev, d) => { for (const f of handlers[ev] ?? []) await f(d, { t: ev, s: 1, d }); };
  return { inst, fire, status: () => status() };
}
const msg = (id, content = 'hi') => ({ id, channel_id: '10', guild_id: G, author: { id: '900', username: 'u900' }, content, timestamp: 'T' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bbdeliv-'));
const readState = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('body carries delivery_id (= Idempotency-Key) and per-item dedupe_key; no redelivery flag on a first send', async () => {
  const rx = await receiver(() => 0); const dir = tmp();
  const b = await start(rx.url, dir);
  await b.fire('MESSAGE_CREATE', msg('600'));
  await b.fire('MESSAGE_UPDATE', { ...msg('600', 'edited'), edited_timestamp: '2026-10-19T10:00:01Z' });
  await sleep(400); await b.inst.teardown(); rx.close();
  assert.equal(rx.reqs.length, 1);
  const { h, body } = rx.reqs[0];
  assert.match(body.delivery_id, /^[0-9a-f]{32}$/);
  assert.equal(body.delivery_id, h['idempotency-key']);
  assert.equal(body.delivery_id, key('create:600,edit:600'));
  assert.deepEqual(body.messages.map((m) => m.dedupe_key), ['create:600', 'edit:600:2026-10-19T10:00:01Z']);
  assert.equal('redelivery' in body, false); assert.equal(h['x-fluxer-redelivery'], undefined);
});

test('stop drains an in-flight POST: the 2xx is recorded and a restart does not re-send it', async () => {
  const rx = await receiver(() => 700); const dir = tmp();
  const a = await start(rx.url, dir);
  await a.fire('MESSAGE_CREATE', msg('610'));
  while (rx.reqs.length === 0) await sleep(20);
  const t0 = Date.now(); await a.inst.teardown();
  assert.ok(Date.now() - t0 >= 500, 'teardown waited for the answer');
  assert.deepEqual(readState(dir, 'outbox.json').items, []);
  assert.equal(readState(dir, 'outbox.json').inflight, null);
  assert.ok(readState(dir, 'delivered.json').items.includes('create:610'));
  const b = await start(rx.url, dir); await sleep(400); await b.inst.teardown(); rx.close();
  assert.equal(rx.reqs.length, 1, 'no duplicate after restart');
});

test('drain timeout keeps the batch; the restart re-sends it once with the same delivery_id and redelivery flags', async () => {
  const hang = await receiver(() => 'hang'); const dir = tmp();
  const a = await start(hang.url, dir, { drain_seconds: 0.2 });
  await a.fire('MESSAGE_CREATE', msg('620'));
  while (hang.reqs.length === 0) await sleep(20);
  const t0 = Date.now(); await a.inst.teardown(); hang.close();
  assert.ok(Date.now() - t0 < 1500, 'drain is bounded');
  const ob = readState(dir, 'outbox.json');
  assert.equal(ob.items.length, 1); assert.equal(ob.inflight.unknown, true); assert.equal(ob.inflight.key, hang.reqs[0].body.delivery_id);
  const rx = await receiver(() => 0);
  const b = await start(rx.url, dir); await sleep(400);
  assert.equal(rx.reqs.length, 1);
  const { h, body } = rx.reqs[0];
  assert.equal(body.delivery_id, hang.reqs[0].body.delivery_id); assert.equal(h['idempotency-key'], hang.reqs[0].h['idempotency-key']);
  assert.equal(body.redelivery, true); assert.equal(h['x-fluxer-redelivery'], '1');
  assert.equal(body.messages[0].dedupe_key, 'create:620');
  assert.equal(b.status().redelivered, 1);
  // the next new message is a normal send again
  await b.fire('MESSAGE_CREATE', msg('621')); await sleep(400); await b.inst.teardown(); rx.close();
  assert.equal(rx.reqs.length, 2); assert.equal('redelivery' in rx.reqs[1].body, false);
  assert.equal(readState(dir, 'outbox.json').inflight, null);
});

test('a batch or item that already got a 2xx is never sent again', async () => {
  const dir = tmp();
  const item = (id) => ({ event: 'create', id, channel_id: '10', channel_name: 'general', guild_id: G, content: 'x', reason: 'all', edited_timestamp: null });
  fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ items: [item('630')], dropped: 0, inflight: { key: key('create:630'), items: ['create:630'], at: 'T', unknown: true } }));
  fs.writeFileSync(path.join(dir, 'delivered.json'), JSON.stringify({ keys: [], items: ['create:630'] }));
  const rx = await receiver(() => 0);
  const a = await start(rx.url, dir); await sleep(400);
  assert.equal(rx.reqs.length, 0); assert.equal(a.status().skipped_delivered, 1); await a.inst.teardown();
  // same by batch key
  fs.writeFileSync(path.join(dir, 'outbox.json'), JSON.stringify({ items: [item('631')], dropped: 0 }));
  fs.writeFileSync(path.join(dir, 'delivered.json'), JSON.stringify({ keys: [key('create:631')], items: [] }));
  const b = await start(rx.url, dir); await sleep(400); await b.inst.teardown(); rx.close();
  assert.equal(rx.reqs.length, 0); assert.deepEqual(readState(dir, 'outbox.json').items, []);
});
