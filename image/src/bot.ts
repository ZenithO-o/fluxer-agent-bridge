import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { Client, Events } from '@fluxerjs/core';
import { logger, type Logger } from './log.js';
import { OWNER, STATE_DIR, INSTANCE, type LoadedBot } from './config.js';
import { PLUGINS } from './plugins/index.js';
import type { CommandSpec, Dispatch, PluginContext, PluginInstance } from './plugin.js';

export type BotState = 'starting' | 'ready' | 'reconnecting' | 'failed' | 'stopped';
const FATAL = new Set([4004, 4010, 4011, 4012]);
const PRESENCE_MIN_GAP_MS = 15000;      // default for bots without activity-status (health changes only)
const PRESENCE_MAX_PER_MIN = 12;        // default cap on op 3 sends per rolling minute
const PRESENCE_MAX_PER_20S = 4;         // hard cap: Fluxer documents max 5 presence updates per 20 s per session

export class BotRuntime {
  state: BotState = 'starting';
  stateSince = Date.now();
  readyAt: number | null = null;
  lastAckAt: number | null = null;
  lastClose: { code: number; at: string } | null = null;
  sessions = 0; resumes = 0;
  failReason: string | null = null;
  private client: Client | null = null;
  private log: Logger;
  private handlers = new Map<string, Array<(d: any, p: Dispatch) => any>>();
  private sessionStartFns: Array<(i: { resumed: false; firstStart: boolean }) => any> = [];
  private commands = new Map<string, CommandSpec>();
  private plugins: Array<{ name: string; inst: PluginInstance | void; status?: () => Record<string, unknown>; errors: number; disabled: boolean }> = [];
  private degraded = new Map<string, { reason: string; level: 'idle' | 'dnd' }>();
  private note: string | null = null;
  private lastPresenceKey = ''; private lastPresenceAt = 0; private presenceTimer: NodeJS.Timeout | null = null;
  private activity: string | null = null;
  private presenceGapMs = PRESENCE_MIN_GAP_MS; private presenceMaxPerMin = PRESENCE_MAX_PER_MIN;
  private presenceSends: number[] = []; presenceUpdates = 0; presenceCoalesced = 0;
  private controls = new Map<string, (args: Record<string, unknown>) => unknown>();
  private dispatchHooked = false; private pingHooked = false;
  private userId: string | null = null;

  constructor(public spec: LoadedBot) { this.log = logger(`${OWNER}/${spec.name}`); }

  private setState(s: BotState) { if (s !== this.state) { this.state = s; this.stateSince = Date.now(); this.log.info(`state -> ${s}`); } }

  async start() {
    const { config, secrets } = this.spec;
    const token = secrets.FLUXER_BOT_TOKEN;
    if (!token) { this.fail('FLUXER_BOT_TOKEN missing in secrets.env'); return; }
    // activity-status reads the bot's own TYPING_START as "Responding", so it must not be filtered at the gateway.
    const wantsTyping = config.plugins.some((p) => p.use === 'activity-status' && p.typing_means_responding !== false);
    const ignoredEvents = wantsTyping ? config.ignored_events.filter((e) => e !== 'TYPING_START') : config.ignored_events;
    const client = await Client.fromDiscovery(INSTANCE, {
      ignoredEvents,
      presence: this.presenceOptions(),
      WebSocket: WebSocket as any,
      gatewayDebug: true,
      logLevel: 'warn',
      cache: { messages: false } as any,
    } as any);
    this.client = client;
    await this.loadPlugins();

    client.on(Events.ShardReady, () => {
      this.hookSocket();
      this.userId = (client.user as any)?.id ?? this.userId;
      this.sessions++; this.readyAt = Date.now(); this.lastAckAt = Date.now();
      this.setState('ready');
      this.log.info('READY (fresh session)', { session_no: this.sessions });
      const firstStart = this.sessions === 1;
      this.pushPresence(true);
      for (const fn of this.sessionStartFns) Promise.resolve().then(() => fn({ resumed: false, firstStart })).catch((e) => this.log.warn('onSessionStart error', { error: String(e) }));
    });
    client.on(Events.ShardResumed, () => { this.resumes++; this.lastAckAt = Date.now(); this.setState('ready'); this.log.info('RESUMED', { resumes: this.resumes }); setTimeout(() => this.pushPresence(true), 1500); });
    client.on(Events.ShardDisconnect, (_id: number, code: number) => {
      this.lastClose = { code, at: new Date().toISOString() };
      this.log.warn('gateway closed', { code });
      if (FATAL.has(code)) this.fail(`gateway close ${code}`);
      else if (this.state !== 'stopped' && this.state !== 'failed') this.setState('reconnecting');
    });
    client.on(Events.Debug, (m: string) => { if (/Reconnect|Invalid session|Resum|Identif|Closed|ack missed/i.test(m)) this.log.info('gateway', { debug: m }); });
    client.on(Events.Error, (e: Error) => this.log.warn('client error', { error: e?.message }));

    try { await client.login(token); }
    catch (e) { this.fail(`login failed: ${(e as Error).message}`); }
  }

  /** Attach raw-dispatch and heartbeat listeners once the WebSocketManager exists (it is created inside login). */
  private hookSocket() {
    const c = this.client!;
    if (!this.dispatchHooked) {
      this.dispatchHooked = true;
      (c.ws as any).on('dispatch', ({ payload }: { payload: Dispatch }) => this.onDispatch(payload));
    }
    if (!this.pingHooked) {
      const shard = (c.ws as any).getShard?.(0);
      if (shard) { this.pingHooked = true; shard.on('ping', () => { this.lastAckAt = Date.now(); }); this.log.debug('heartbeat listener attached'); } else this.log.warn('no shard handle; health uses dispatch activity only');
    }
  }

  private onDispatch(p: Dispatch) {
    this.lastAckAt = Math.max(this.lastAckAt ?? 0, Date.now());
    if (p.t === 'READY' && p.d?.user?.id) { this.userId = String(p.d.user.id); setTimeout(() => this.pushPresence(true), 1500); }
    const fns = this.handlers.get(p.t);
    if (fns) for (const fn of fns) this.safe(fn, p);
    if (p.t === 'MESSAGE_CREATE' && this.commands.size) this.routeCommand(p.d);
  }

  private safe(fn: (d: any, p: Dispatch) => any, p: Dispatch) {
    const owner = (fn as any).__plugin as string;
    const pl = this.plugins.find((x) => x.name === owner);
    if (pl?.disabled) return;
    Promise.resolve().then(() => fn(p.d, p)).catch((e) => {
      this.log.error('plugin handler error', { plugin: owner, event: p.t, error: String(e?.message ?? e) });
      if (pl && ++pl.errors >= 20) { pl.disabled = true; this.degraded.set(`plugin:${owner}`, { reason: `plugin ${owner} disabled`, level: 'dnd' }); this.pushPresence(); }
    });
  }

  private async routeCommand(m: any) {
    const prefix = this.spec.config.prefix;
    if (!m?.content?.startsWith(prefix) || m.author?.bot || m.author?.id === this.userId) return;
    const [name, ...args] = m.content.slice(prefix.length).trim().split(/\s+/);
    const spec = this.commands.get((name || '').toLowerCase());
    if (!spec) return;
    // TODO(perms): spec.perms check via member.permissionsIn when the first moderation plugin lands.
    try {
      await spec.handler({ message: m, args, reply: async (content) => { await this.client!.rest.post(`/channels/${m.channel_id}/messages`, { body: { content, message_reference: { message_id: m.id } } } as any); } });
    } catch (e) { this.log.warn('command error', { command: name, error: String((e as Error).message) }); }
  }

  private async loadPlugins() {
    for (const spec of this.spec.config.plugins) {
      const def = PLUGINS[spec.use];
      if (!def) { this.log.error('unknown plugin', { plugin: spec.use }); continue; }
      const stateDir = path.join(STATE_DIR, this.spec.name, def.name);
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const entry: (typeof this.plugins)[number] = { name: def.name, inst: undefined, errors: 0, disabled: false };
      const ctx: PluginContext = {
        client: this.client!,
        bot: { name: this.spec.name, owner: OWNER, userId: () => this.userId, config: this.spec.config },
        config: spec, secrets: Object.freeze({ ...this.spec.secrets }), log: logger(`${OWNER}/${this.spec.name}/${def.name}`), stateDir,
        on: (ev, fn) => { (fn as any).__plugin = def.name; const a = this.handlers.get(ev) ?? []; a.push(fn); this.handlers.set(ev, a); },
        onSessionStart: (fn) => this.sessionStartFns.push(fn),
        command: (name, cs) => this.commands.set(name.toLowerCase(), cs),
        health: {
          degrade: (reason, level = 'idle') => { const k = `plugin:${def.name}`; const prev = this.degraded.get(k); if (prev?.reason !== reason || prev?.level !== level) { this.degraded.set(k, { reason, level }); this.pushPresence(); } },
          clear: () => { if (this.degraded.delete(`plugin:${def.name}`)) this.pushPresence(); },
          setNote: (n) => { this.note = n; this.pushPresence(); },
        },
        status: (fn) => { entry.status = fn; },
        emit: (ev, data) => { const fns = this.handlers.get(ev); if (fns) for (const fn of fns) this.safe(fn, { t: ev, s: null, d: data }); },
        control: (name, fn) => { this.controls.set(name, fn); },
        presence: {
          setActivity: (text) => { const t = text ? text.slice(0, 128) : null; if (t !== this.activity) { this.activity = t; this.pushPresence(); } },
          setRate: (gap, max) => { this.presenceGapMs = Math.max(1000, gap); this.presenceMaxPerMin = Math.max(1, Math.min(15, max)); },
          current: () => { const p = this.presenceOptions(); return { status: p.status, text: p.customStatus?.text ?? null }; },
        },
      };
      try { entry.inst = await def.setup(ctx); this.log.info('plugin loaded', { plugin: def.name }); }
      catch (e) { this.log.error('plugin setup failed', { plugin: def.name, error: String((e as Error).message) }); entry.disabled = true; }
      this.plugins.push(entry);
    }
  }

  /** Presence = health. Worst degradation wins; dnd > idle > configured status. */
  private presenceOptions() {
    const worst = [...this.degraded.values()].sort((a, b) => (a.level === 'dnd' ? -1 : 1) - (b.level === 'dnd' ? -1 : 1))[0];
    const status = worst ? worst.level : this.spec.config.presence.status;
    const base = this.spec.config.presence.text;
    // Health wins: degradation > note (webhook not configured/held) > activity > configured text.
    const text = worst ? worst.reason : this.note ? (base ? `${base} (${this.note})` : this.note) : (this.activity ?? base);
    return { status, customStatus: text ? { text: text.slice(0, 128) } : null } as any;
  }
  private pushPresence(force = false) {
    if (!this.client?.user || this.state !== 'ready') return;
    const p = this.presenceOptions(); const key = JSON.stringify(p);
    if (!force && key === this.lastPresenceKey) return;
    // Coalesce: at most one update per presenceGapMs and presenceMaxPerMin per rolling minute; the latest state wins.
    const now = Date.now();
    this.presenceSends = this.presenceSends.filter((t) => now - t < 60000);
    let wait = Math.max(this.lastPresenceAt + this.presenceGapMs - now, 0);
    if (this.presenceSends.length >= this.presenceMaxPerMin) wait = Math.max(wait, this.presenceSends[0] + 60000 - now);
    const recent = this.presenceSends.filter((t) => now - t < 20000);
    if (recent.length >= PRESENCE_MAX_PER_20S) wait = Math.max(wait, recent[0] + 20000 - now);
    if (wait > 0 && (!force || recent.length >= PRESENCE_MAX_PER_20S)) {
      this.presenceCoalesced++;
      if (!this.presenceTimer) this.presenceTimer = setTimeout(() => { this.presenceTimer = null; this.pushPresence(); }, wait);
      return;
    }
    this.lastPresenceKey = key; this.lastPresenceAt = now; this.presenceSends.push(now); this.presenceUpdates++;
    try { (this.client.user as any).setPresence(p); this.log.info('presence', { status: p.status, text: p.customStatus?.text ?? null }); } catch (e) { this.log.warn('presence failed', { error: String(e) }); }
  }

  private fail(reason: string) {
    this.failReason = reason; this.setState('failed');
    this.log.error('bot failed (not retrying until config changes)', { reason });
    void this.client?.destroy().catch(() => undefined);
  }

  /** Drill: drop the gateway socket without a close frame (like a network cut). Expect RESUMED, no lost events. */
  drillDropSocket() {
    const shard = (this.client?.ws as any)?.getShard?.(0);
    const sock = shard?.ws;
    if (sock?.terminate) { this.log.warn('DRILL: terminating gateway socket (no close frame)'); sock.terminate(); return true; }
    return false;
  }

  async stop() {
    this.setState('stopped');
    for (const p of this.plugins) { try { await p.inst?.teardown?.(); } catch { /* ignore */ } }
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    try { await this.client?.destroy(); } catch { /* ignore */ } // close 1000: session ends, Fluxer shows offline ~5 s later
  }

  async control(name: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.controls.get(name);
    if (!fn) throw new Error(`unknown control command "${name}" (have: ${[...this.controls.keys()].join(', ') || 'none'})`);
    return await fn(args);
  }

  healthy(): boolean {
    if (this.state !== 'ready') return false;
    return this.lastAckAt !== null && Date.now() - this.lastAckAt < 2 * 41250 + 15000;
  }

  status() {
    let ping = -1; try { ping = (this.client?.ws as any)?.ping ?? -1; } catch { /* not connected */ }
    return {
      bot: this.spec.name, user_id: this.userId, state: this.state, since: new Date(this.stateSince).toISOString(), healthy: this.healthy(),
      ping_ms: ping, last_ack_s_ago: this.lastAckAt ? Math.round((Date.now() - this.lastAckAt) / 1000) : null,
      sessions: this.sessions, resumes: this.resumes, last_close: this.lastClose, fail_reason: this.failReason,
      presence: this.presenceOptions(), presence_sent: this.lastPresenceKey ? JSON.parse(this.lastPresenceKey) : null,
      presence_updates: this.presenceUpdates, presence_coalesced: this.presenceCoalesced, activity: this.activity, degraded: [...this.degraded.values()],
      plugins: this.plugins.map((p) => ({ name: p.name, disabled: p.disabled, errors: p.errors, ...(p.status ? p.status() : {}) })),
    };
  }
}
