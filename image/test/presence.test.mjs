// Health always wins over activity text in the presence the bot sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BotRuntime } from '../dist/bot.js';
import { idleText, DEFAULT_IDLE_TEXT } from '../dist/config.js';
import fs from 'node:fs';

test('presence precedence: degraded > note > activity > configured text', () => {
  const rt = new BotRuntime({ name: 'my_bot', dir: '/x', hash: 'h', secrets: {},
    config: { name: 'my_bot', enabled: true, presence: { status: 'online', text: 'Online' }, ignored_events: [], prefix: '!', plugins: [] } });
  const p = () => { const o = rt.presenceOptions(); return `${o.status}|${o.customStatus?.text ?? ''}`; };
  assert.equal(p(), 'online|Online');
  rt.activity = "Reading Alice's message"; assert.equal(p(), "online|Reading Alice's message");
  rt.degraded.set('plugin:webhook-forward', { reason: 'webhook down, 12 queued', level: 'idle' });
  assert.equal(p(), 'idle|webhook down, 12 queued', 'degradation masks activity');
  rt.degraded.set('plugin:x', { reason: 'webhook HTTP 401', level: 'dnd' }); assert.equal(p(), 'dnd|webhook HTTP 401');
  rt.degraded.clear(); rt.note = 'webhook held'; assert.equal(p(), 'online|Online (webhook held)');
  rt.note = null; assert.equal(p(), "online|Reading Alice's message");
});

test('presence rate cap: never more than 4 updates per 20 s, even when forced', () => {
  const rt = new BotRuntime({ name: 'b', dir: '/x', hash: 'h', secrets: {},
    config: { name: 'b', enabled: true, presence: { status: 'online', text: 'Online' }, ignored_events: [], prefix: '!', plugins: [] } });
  let sent = 0;
  rt.client = { user: { setPresence() { sent++; } } }; rt.state = 'ready';
  for (let i = 0; i < 6; i++) { rt.activity = `step ${i}`; rt.pushPresence(true); }
  assert.equal(sent, 4); assert.equal(rt.presenceCoalesced, 2);
  clearTimeout(rt.presenceTimer);
});

test('idle status: idle_status > presence.text > "Online"; template ships the generic default', () => {
  assert.equal(DEFAULT_IDLE_TEXT, 'Online');
  assert.equal(idleText({}), 'Online');
  assert.equal(idleText({ presence: { status: 'online' } }), 'Online');
  assert.equal(idleText({ presence: { text: 'Here' } }), 'Here');
  assert.equal(idleText({ idle_status: 'Taking requests', presence: { text: 'Here' } }), 'Taking requests');
  assert.equal(idleText({ presence: { text: '' } }), '', 'explicit empty = no custom status');
  const tpl = new URL('../../templates/bot.toml', import.meta.url);
  if (fs.existsSync(tpl)) { const t = fs.readFileSync(tpl, 'utf8'); assert.match(t, /text = "Online"/); assert.ok(!/grok|relaying/i.test(t)); }
});
