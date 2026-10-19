// The webhook payload stays byte-identical to schema 2; the only additions are thread.applied_tags on tagged threads and the
// top-level trust block (injection.test.mjs covers its contents).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import plugin from '../dist/plugins/webhook-forward.js';
import { appliedTags } from '../dist/plugins/tags.js';
import { run, normalize } from './lib/harness.mjs';

const golden = fs.readFileSync(new URL('./lib/full-v2.golden.txt', import.meta.url), 'utf8').trimEnd();

test('payload: byte-identical to schema 2 apart from thread.applied_tags and trust', async () => {
  const out = normalize((await run(plugin)).join('\n'));
  assert.equal(out.replace(/,"applied_tags":\[[^\]]*\]/g, '').replace(/,"trust":\{[^{}]*\}/g, ''), golden);
  const msgs = JSON.parse(out.split('\n')[0]).messages;
  assert.deepEqual(msgs.find((m) => m.id === '503').thread.applied_tags, [{ id: '32', name: 'Bug' }, { id: '31', name: 'Idea' }]);
  assert.equal('applied_tags' in msgs.find((m) => m.id === '504').thread, false, 'untagged thread unchanged');
  assert.ok(msgs.find((m) => m.id === '503').attachments.length === 1, 'attachments kept');
});

test('appliedTags: unknown tag ids keep their id with a null name', () => {
  assert.deepEqual(appliedTags({ applied_tags: ['1', '2'] }, { available_tags: [{ id: '1', name: 'A' }] }), [{ id: '1', name: 'A' }, { id: '2', name: null }]);
  assert.deepEqual(appliedTags({}, null), []);
});
