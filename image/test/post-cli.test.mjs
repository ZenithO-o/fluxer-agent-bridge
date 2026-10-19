// `cli.js post` against a stub Fluxer API: refusals make no write; an allowed post types first, then posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const G = '100000000000000010', H = '100000000000000099';
const CH = { '2000000001': { id: '2000000001', type: 0, guild_id: G }, '2000000002': { id: '2000000002', type: 0, guild_id: H } };

test('post: cross-guild refused before any write; dry run writes nothing; allowed post = typing then message', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const port = srv.address().port;
      if (req.url === '/.well-known/fluxer') return res.end(JSON.stringify({ endpoints: { api: `http://127.0.0.1:${port}/api` } }));
      const m = req.url.match(/^\/api\/v1\/channels\/(\d+)$/);
      if (req.method === 'GET' && m) return CH[m[1]] ? res.end(JSON.stringify(CH[m[1]])) : (res.writeHead(404), res.end('{}'));
      if (req.method === 'POST' && req.url.endsWith('/typing')) return res.writeHead(204).end();
      if (req.method === 'POST' && req.url.endsWith('/messages')) { assert.equal(req.headers.authorization, 'Bot dummy.token-for-tests'); return res.end(JSON.stringify({ id: '3000000001', ...JSON.parse(b) })); }
      res.writeHead(500).end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bbcfg-')); fs.mkdirSync(path.join(cfg, 'my_bot'));
  fs.writeFileSync(path.join(cfg, 'my_bot', 'secrets.env'), 'FLUXER_BOT_TOKEN=dummy.token-for-tests\n');
  const env = { ...process.env, BB_CFG_DIR: cfg, FLUXER_INSTANCE: `http://127.0.0.1:${srv.address().port}`, FLUXER_CONTEXT_GUILD: '' };
  const cli = (args, extra = {}) => new Promise((r) => execFile(process.execPath, [new URL('../dist/cli.js', import.meta.url).pathname, 'post', 'my_bot', ...args],
    { env: { ...env, ...extra } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
  const writes = () => seen.filter((s) => s.startsWith('POST'));

  let r = await cli(['2000000002', 'hi']);
  assert.equal(r.code, 3); assert.match(r.stderr, /no context guild/);
  r = await cli(['--guild', G, '2000000002', 'hi']);
  assert.equal(r.code, 3); assert.match(r.stderr, /is in guild 100000000000000099/);
  r = await cli(['--dm', '2000000001', 'hi']);
  assert.equal(r.code, 3); assert.match(r.stderr, /not a DM/);
  r = await cli(['--guild', G, '2000000009', 'hi']);
  assert.equal(r.code, 3); assert.match(r.stderr, /not resolvable/);
  r = await cli(['2000000002', 'hi'], { FLUXER_CONTEXT_GUILD: G });
  assert.equal(r.code, 3, 'env context is enforced too');
  r = await cli(['--guild', G, '--dry-run', '2000000001', 'hi']);
  assert.equal(r.code, 0); assert.match(r.stdout, /ok \(dry run\)/);
  assert.deepEqual(writes(), [], 'no write for refusals or dry run');
  r = await cli(['--guild', G, '--reply-to', '2999999999', '2000000001', 'hello', 'there']);
  assert.equal(r.code, 0); assert.equal(r.stdout.trim(), '3000000001');
  assert.deepEqual(writes(), ['POST /api/v1/channels/2000000001/typing', 'POST /api/v1/channels/2000000001/messages']);
  assert.ok(!r.stdout.includes('dummy') && !r.stderr.includes('dummy'), 'token never printed');
  srv.close();
});
