import path from 'node:path';
import crypto from 'node:crypto';
import { definePlugin } from '../plugin.js';
import { JsonKV } from '../store.js';
import { appliedTags } from './tags.js';
import { trustBlock, wrapItem } from '../untrusted.js';
import { BoundedMap, GATEWAY_EVENTS, MODES, THREAD_TYPES, decideDelete, decideEvent, decideMessage, nickOf, parseEvents, parseGuilds, parseIgnore, policyFor, toIdSet,
  type EventKind, type FilterOpts, type Mode, type Reason } from './forward-filter.js';

/**
 * webhook-forward: Fluxer messages -> filter -> batch -> POST to the owner's webhook (an agent's inbox).
 * Secrets (this bot's secrets.env): WEBHOOK_URL, and WEBHOOK_AUTH (full Authorization header value)
 * or legacy WEBHOOK_KEY (sent as "Bearer <key>" plus X-Automation-Key).
 * Without WEBHOOK_URL (or with hold = true) messages are queued in the bounded outbox, not sent.
 * Filtering lives in forward-filter.ts (mode "all" is the default: every visible message except the bot's own).
 * Every POST carries a `trust` block naming the untrusted text fields; trust_wrap = true (default off) also wraps them
 * in place as «fluxer:u»…«/fluxer:u» (see untrusted.ts). The outbox always stores raw values.
 * Delivery is at-least-once. On stop the loop takes no new batch and waits up to drain_seconds (8) for an in-flight POST.
 * Each POST body carries `delivery_id` (= the Idempotency-Key, stable across redeliveries) and messages[].dedupe_key.
 * A batch sent without a definitive answer is persisted as `inflight`; after a restart it is re-sent with the same
 * delivery_id / Idempotency-Key, `redelivery: true` and `X-Fluxer-Redelivery: 1`. Keys and items that got a 2xx are kept in a small
 * persisted ring (delivered.json) and never sent again.
 */
interface Item { [k: string]: unknown; id: string }
/** inflight: the batch whose POST was sent and has no definitive answer yet (survives a restart). */
interface Inflight { key: string; items: string[]; at: string; unknown: boolean }
interface OutboxState { [k: string]: unknown; items: Item[]; dropped: number; inflight?: Inflight | null }
interface DeliveredState { [k: string]: unknown; keys: string[]; items: string[] }
interface CursorState { [k: string]: unknown; channels: Record<string, string> }

const ids = toIdSet;
const LEGACY_REASON: Record<string, string> = { ping: 'mention', 'reply-to-bot': 'reply', 'reaction-to-bot': 'reaction', dm: 'dm', home: 'home', all: 'all' };
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const snowflakeGt = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a > b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEXTISH = new Set([0, 5, 10, 11, 12]);

export default definePlugin({
  name: 'webhook-forward',
  setup(ctx) {
    const c = ctx.config;
    if (c.mode !== undefined && !MODES.includes(String(c.mode) as Mode)) ctx.log.warn('unknown mode, using "all"', { mode: String(c.mode) });
    const mode = (MODES.includes(String(c.mode) as Mode) ? c.mode : 'all') as Mode;
    const home = ids(c.home_channels), allow = ids(c.channels), deny = ids(c.skip_channels), skipAuthors = ids(c.skip_authors ?? ['self']);
    const ignore = parseIgnore(c.ignore);
    const { policies: guilds, warnings: guildWarnings } = parseGuilds((ctx.bot.config as any).guilds);
    for (const w of guildWarnings) ctx.log.warn(w);
    if (guilds.size) ctx.log.info('per-guild policies', { guilds: Object.fromEntries([...guilds].map(([g, p]) => [g, p.forward ?? 'default'])) });
    for (const [g, p] of guilds) if (p.channels?.size) ctx.log.info('per-channel policies', { guild: g, channels: Object.fromEntries([...p.channels].map(([c, cp]) => [c, cp.forward ?? 'inherit'])) });
    const includeDms = bool(c.include_dms, true), includeEdits = bool(c.include_edits, true), includeBots = bool(c.include_bots, true);
    const includeDeletes = bool(c.include_deletes, true);
    const { kinds: eventKinds, unknown: unknownEvents } = parseEvents(c.events);
    if (unknownEvents.length) ctx.log.warn('unknown events in config (ignored)', { events: unknownEvents });
    if (eventKinds.has('typing') && (ctx.bot.config.ignored_events ?? []).includes('TYPING_START'))
      ctx.log.warn('events includes "typing" but ignored_events has TYPING_START; remove it there to receive typing');
    const includeBackfill = bool(c.include_backfill, true), everyoneIsPing = bool(c.everyone_is_ping, false);
    const hold = bool(c.hold, false), testFlag = bool(c.test, false), trustWrap = bool(c.trust_wrap, false);
    const batchMs = num(c.batch_seconds, 3) * 1000, maxPerPost = num(c.max_per_post, 50), outboxMax = num(c.outbox_max, 500);
    const backfillMax = num(c.backfill_max, 50), maxPostBytes = num(c.max_post_bytes, 512 * 1024), drainMs = num(c.drain_seconds, 8) * 1000;
    const url = ctx.secrets.WEBHOOK_URL || '';
    const auth = ctx.secrets.WEBHOOK_AUTH || (ctx.secrets.WEBHOOK_KEY ? `Bearer ${ctx.secrets.WEBHOOK_KEY}` : '');
    const legacyKey = ctx.secrets.WEBHOOK_AUTH ? '' : ctx.secrets.WEBHOOK_KEY || '';
    const host = (() => { try { return new URL(url).host; } catch { return ''; } })();

    const outbox = new JsonKV<OutboxState>(path.join(ctx.stateDir, 'outbox.json'), { items: [], dropped: 0 });
    const cursors = new JsonKV<CursorState>(path.join(ctx.stateDir, 'cursors.json'), { channels: {} });
    const delivered = new JsonKV<DeliveredState>(path.join(ctx.stateDir, 'delivered.json'), { keys: [], items: [] });
    const deliveredKeys = new Set(delivered.data.keys ?? []), deliveredItems = new Set(delivered.data.items ?? []);
    /** Per-item dedupe key sent as messages[].dedupe_key: "create:<message id>" / "delete:<id>", "edit:<id>:<edited_timestamp>"
     *  (each edit is its own event), and the synthetic id ("reaction_add:<ms>:<seq>") for non-message events. */
    const itemKey = (it: Item) => (String(it.id).includes(':') ? String(it.id)
      : it.event === 'edit' && it.edited_timestamp ? `edit:${it.id}:${it.edited_timestamp}` : `${it.event}:${it.id}`);
    const idemKey = (batch: Item[], test = false) => crypto.createHash('sha256').update(batch.map((b) => `${b.event}:${b.id}`).join(',') + (test ? ':test' : '')).digest('hex').slice(0, 32);
    function markDelivered(key: string, batch: Item[]) {
      delivered.data.keys = [...(delivered.data.keys ?? []), key].slice(-200);
      delivered.data.items = [...(delivered.data.items ?? []), ...batch.map(itemKey)].slice(-2000);
      deliveredKeys.clear(); for (const k of delivered.data.keys) deliveredKeys.add(k);
      deliveredItems.clear(); for (const k of delivered.data.items) deliveredItems.add(k);
      delivered.flush();
    }
    const recent = new Set<string>(); const recentQ: string[] = [];
    const remember = (k: string) => { if (recent.has(k)) return false; recent.add(k); recentQ.push(k); if (recentQ.length > 2000) recent.delete(recentQ.shift()!); return true; };

    // own message ids (reply-to-bot detection when referenced_message is absent) and recent authors (for deletes)
    const ownState = new JsonKV<{ [k: string]: unknown; ids: string[] }>(path.join(ctx.stateDir, 'own-messages.json'), { ids: [] });
    const ownIds = new BoundedMap<true>(2000); for (const i of ownState.data.ids ?? []) ownIds.set(String(i), true);
    const authors = new BoundedMap<{ id: string; bot: boolean }>(5000);
    // messages that qualified in a mentions-mode guild: their edits and deletes are forwarded, nothing else is
    const qualState = new JsonKV<{ [k: string]: unknown; ids: [string, string][] }>(path.join(ctx.stateDir, 'qualified.json'), { ids: [] });
    const qualified = new BoundedMap<string>(5000); for (const [i, r] of qualState.data.ids ?? []) qualified.set(String(i), String(r));
    const botUsers = new Set<string>(); // user ids seen authoring as bots (for events that carry only a user id)
    const refCache = new BoundedMap<string | null>(500); // referenced message id -> author id (REST fallback)

    const st = { state: !url ? 'not-configured' : hold ? 'held' : 'ready', lastDelivery: null as null | string, lastError: null as null | string,
      failedRounds: 0, forwarded: 0, filtered: 0, backfilled: 0, paused: false, posts: 0, redelivered: 0, skipped_delivered: 0,
      queued_by_reason: {} as Record<string, number>, queued_by_event: {} as Record<string, number>, filtered_by: {} as Record<string, number>,
      last_queued: null as null | { event: string; id: string; channel: string; reason: string; author_bot: boolean; at: string } };
    const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
    ctx.status(() => ({ webhook_host: host || null, mode, ignore: { channels: ignore.channels.size, users: ignore.users.size, bots: ignore.bots, strict: ignore.strict },
      ...st, outbox: outbox.data.items.length, dropped: outbox.data.dropped }));
    const filterOpts = (): FilterOpts => ({ mode, selfId: ctx.bot.userId(), home, allow, deny, skipAuthors, includeDms, includeBots,
      everyoneIsPing, myRoles, ownMessageIds: ownIds, ignore, guilds, qualified });

    // ---------- helpers ----------
    const chanCache = new Map<string, any>(); const guildName = new Map<string, string>();
    let myRoles = new Set<string>();
    async function channel(id: string) {
      if (chanCache.has(id)) return chanCache.get(id);
      try { const ch: any = await ctx.client.rest.get(`/channels/${id}`); chanCache.set(id, ch); return ch; } catch { return null; }
    }
    async function gname(gid?: string) {
      if (!gid) return null;
      if (!guildName.has(gid)) { try { const g: any = await ctx.client.rest.get(`/guilds/${gid}`); guildName.set(gid, g?.name ?? gid); } catch { return gid; } }
      return guildName.get(gid)!;
    }

    /** If the message replies to something and we cannot tell whose it was, look it up once (cached). */
    async function resolveReplyAuthor(m: any) {
      const ref = m.message_reference?.message_id;
      if (!ref || m.referenced_message?.author?.id || ownIds.has(String(ref))) return;
      const refCh = m.message_reference?.channel_id ?? m.channel_id;
      let aid = refCache.get(String(ref));
      if (aid === undefined) {
        try { const r: any = await ctx.client.rest.get(`/channels/${refCh}/messages/${ref}`); aid = r?.author?.id ? String(r.author.id) : null; }
        catch { aid = null; }
        refCache.set(String(ref), aid);
      }
      if (aid && aid === ctx.bot.userId()) ownIds.set(String(ref), true);
    }

    /** Thread info. applied_tags ([{id, name}]) is added only when the thread has tags; everything else is unchanged. */
    function threadObj(ch: any, parent: any) {
      const tags = appliedTags(ch, parent);
      return { id: ch.id, name: ch.name, parent_id: ch.parent_id ?? null, parent_name: parent?.name ?? null, parent_is_forum: parent?.type === 15,
        ...(tags.length ? { applied_tags: tags } : {}) };
    }

    async function shape(m: any, event: 'create' | 'edit' | 'delete', reason: Reason, ch: any, backfill: boolean): Promise<Item> {
      const parent = ch?.parent_id ? await channel(String(ch.parent_id)) : null;
      const isThread = ch && [10, 11, 12].includes(ch.type);
      return {
        event, id: m.id, channel_id: m.channel_id,
        channel_name: isThread && parent ? `${parent.name} > ${ch.name}` : ch?.name ?? null,
        guild_id: m.guild_id ?? null, guild_name: await gname(m.guild_id), is_dm: !m.guild_id,
        author: { id: m.author?.id, username: m.author?.username, display_name: m.author?.global_name ?? m.member?.nick ?? m.author?.username, bot: !!m.author?.bot,
          global_name: m.author?.global_name ?? null, nick: m.member?.nick ?? null },
        timestamp: m.timestamp ?? null, edited_timestamp: m.edited_timestamp ?? null,
        content: m.content ?? '',
        attachments: (m.attachments || []).map((a: any) => ({ url: a.url, filename: a.filename, content_type: a.content_type, size: a.size })),
        reply_to: m.referenced_message ? { id: m.referenced_message.id, author_id: m.referenced_message.author?.id, content: String(m.referenced_message.content ?? '').slice(0, 500) } : null,
        reference: m.message_reference ?? null,
        thread: isThread ? threadObj(ch, parent) : null,
        parent_channel_id: ch?.parent_id ?? null,
        reason, legacy_reason: LEGACY_REASON[reason],
        ...(backfill ? { backfill: true } : {}),
      };
    }

    async function handle(m: any, event: 'create' | 'edit', backfill = false) {
      if (!m?.id || !m.channel_id) return;
      if (event === 'create') {
        const cur = cursors.data.channels[m.channel_id];
        if (!cur || snowflakeGt(m.id, cur)) { cursors.data.channels[m.channel_id] = m.id; cursors.save(); }
      }
      const self = ctx.bot.userId();
      if (m.author?.id) {
        authors.set(String(m.id), { id: String(m.author.id), bot: !!m.author.bot || !!m.webhook_id });
        if (m.author.bot && botUsers.size < 10000) botUsers.add(String(m.author.id));
        if (self && String(m.author.id) === self && !ownIds.has(String(m.id))) { ownIds.set(String(m.id), true); ownState.data.ids = ownIds.keys(); ownState.save(2000); }
      }
      if (!remember(`${event}:${m.id}:${m.edited_timestamp ?? ''}`)) return;
      if (m.author?.id && String(m.author.id) !== self) await resolveReplyAuthor(m);
      const ch = await channel(m.channel_id);
      const parentId = ch?.parent_id ? String(ch.parent_id) : null;
      const d = decideMessage(m, parentId, filterOpts(), event);
      if (!d.forward) { st.filtered++; bump(st.filtered_by, d.why); return; }
      if (event === 'create' && m.guild_id && policyFor(guilds, String(m.guild_id), String(m.channel_id ?? ''), parentId)?.forward === 'mentions') {
        qualified.set(String(m.id), d.reason); qualState.data.ids = qualified.keys().map((k) => [k, qualified.get(k)!]); qualState.save(1000);
      }
      queue(await shape(m, event, d.reason, ch, backfill), ch, !!(m.author?.bot || m.webhook_id));
    }

    async function handleDelete(d: any) {
      if (!d?.id || !d.channel_id) return;
      if (!remember(`delete:${d.id}`)) return;
      const author = authors.get(String(d.id)) ?? (ownIds.has(String(d.id)) ? { id: ctx.bot.userId() ?? '', bot: true } : null);
      const ch = await channel(d.channel_id);
      const parentId = ch?.parent_id ? String(ch.parent_id) : null;
      const dec = decideDelete({ ...d, guild_id: d.guild_id ?? ch?.guild_id ?? null }, parentId, author, filterOpts());
      if (!dec.forward) { st.filtered++; bump(st.filtered_by, dec.why); return; }
      const base = await shape({ id: d.id, channel_id: d.channel_id, guild_id: d.guild_id ?? ch?.guild_id ?? null, content: null }, 'delete', dec.reason, ch, false);
      base.author = author ? { id: author.id, username: null, display_name: null, bot: author.bot } : null;
      base.content = null;
      queue(base, ch, !!author?.bot);
    }

    function queue(item: Item, ch: any, authorBot: boolean) {
      enqueue(item);
      bump(st.queued_by_reason, String(item.reason)); bump(st.queued_by_event, String(item.event));
      st.last_queued = { event: String(item.event), id: item.id, channel: ch?.name ?? String(item.channel_id), reason: String(item.reason), author_bot: authorBot, at: new Date().toISOString() };
      ctx.log.info('queued', { event: item.event, id: item.id, channel: ch?.name ?? item.channel_id, reason: item.reason, author_bot: authorBot, backfill: !!item.backfill });
    }

    function enqueue(item: Item) {
      const items = outbox.data.items;
      items.push(item);
      while (items.length > outboxMax) { items.shift(); outbox.data.dropped++; }
      outbox.save(250);
      wake();
    }

    ctx.on('MESSAGE_CREATE', (d) => handle(d, 'create'));
    if (includeEdits) ctx.on('MESSAGE_UPDATE', (d) => { if (d?.content !== undefined && d?.edited_timestamp) return handle(d, 'edit'); });
    if (includeDeletes) {
      ctx.on('MESSAGE_DELETE', (d) => handleDelete(d));
      ctx.on('MESSAGE_DELETE_BULK', async (d) => { for (const id of d?.ids ?? []) await handleDelete({ id, channel_id: d.channel_id, guild_id: d.guild_id }); });
    }
    // keep channel/thread names fresh (cache otherwise lives for the process lifetime)
    for (const ev of ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE']) ctx.on(ev, (d) => { if (d?.id) chanCache.set(String(d.id), d); });
    for (const ev of ['CHANNEL_DELETE', 'THREAD_DELETE']) ctx.on(ev, (d) => { if (d?.id) chanCache.delete(String(d.id)); });

    // ---------- opt-in non-message events (events = [...]) ----------
    let evSeq = 0;
    const userObj = (u: any, member?: any) => (u?.id ? { id: String(u.id), username: u.username ?? null, global_name: u.global_name ?? null,
      nick: member?.nick ?? null, display_name: nickOf(u, member), bot: !!u.bot } : null);
    async function handleEvent(t: string, d: any) {
      let kind = GATEWAY_EVENTS[t];
      if (!kind || !d) return;
      if (kind.startsWith('channel_') && THREAD_TYPES.has(d.type)) kind = kind.replace('channel_', 'thread_') as EventKind;
      if (!eventKinds.has(kind)) return;
      const self = ctx.bot.userId();
      let channelId: string | null = null, actor: any = null, subject: any = null, extra: Record<string, unknown> = {}, toBot = false;
      if (kind.startsWith('reaction')) {
        channelId = d.channel_id ?? null;
        actor = d.member?.user ?? (d.user_id ? { id: d.user_id, bot: authorsBot(d.user_id) } : null);
        const msgAuthor = d.message_author_id ? String(d.message_author_id) : authors.get(String(d.message_id))?.id;
        toBot = !!self && (msgAuthor === self || ownIds.has(String(d.message_id)));
        extra = { message_id: d.message_id ?? null, emoji: d.emoji ? { id: d.emoji.id ?? null, name: d.emoji.name ?? null, animated: !!d.emoji.animated } : null,
          message_author_id: msgAuthor ?? null, ...(t.endsWith('REMOVE_ALL') ? { remove_all: true } : {}) };
      } else if (kind.startsWith('member') || kind.startsWith('ban')) {
        actor = d.user ?? null; subject = d.user ?? null;
        extra = { member: kind === 'member_leave' || kind.startsWith('ban') ? null
          : { nick: d.nick ?? null, roles: d.roles ?? [], joined_at: d.joined_at ?? null } };
      } else if (kind.startsWith('thread') || kind.startsWith('channel')) {
        channelId = String(d.id);
        actor = d.owner_id ? { id: String(d.owner_id), bot: authorsBot(String(d.owner_id)) } : null;
        extra = { channel: { id: String(d.id), name: d.name ?? null, type: d.type ?? null, parent_id: d.parent_id ?? null, owner_id: d.owner_id ?? null } };
      } else if (kind === 'typing') {
        channelId = d.channel_id ?? null;
        actor = d.member?.user ?? (d.user_id ? { id: d.user_id, bot: authorsBot(String(d.user_id)) } : null);
      }
      const ch = channelId ? (kind.endsWith('_delete') ? d : await channel(channelId)) : null;
      const parentId = ch?.parent_id ? String(ch.parent_id) : null;
      const dec = decideEvent(kind, { channelId, parentId, guildId: d.guild_id ?? null, actor: actor?.id ? { id: String(actor.id), bot: !!actor.bot } : null, toBot }, filterOpts());
      if (!dec.forward) { st.filtered++; bump(st.filtered_by, `${kind}:${dec.why}`); return; }
      const parent = parentId ? await channel(parentId) : null;
      const isThread = !!ch && THREAD_TYPES.has(ch.type);
      const item: Item = {
        event: kind, id: `${kind}:${Date.now()}:${++evSeq}`, channel_id: channelId,
        channel_name: isThread && parent ? `${parent.name} > ${ch.name}` : ch?.name ?? null,
        guild_id: d.guild_id ?? ch?.guild_id ?? null, guild_name: await gname(d.guild_id ?? ch?.guild_id), is_dm: false,
        author: userObj(actor, d.member), user: subject ? userObj(subject, d) : null,
        timestamp: new Date().toISOString(), edited_timestamp: null, content: null, attachments: [], reply_to: null, reference: null,
        thread: isThread ? threadObj(ch, parent) : null,
        parent_channel_id: parentId, reason: dec.reason, legacy_reason: LEGACY_REASON[dec.reason] ?? dec.reason, ...extra,
      };
      queue(item, ch, !!actor?.bot);
    }
    const authorsBot = (uid: string) => botUsers.has(String(uid));
    if (eventKinds.size) for (const t of Object.keys(GATEWAY_EVENTS)) if (eventKinds.has(GATEWAY_EVENTS[t]) || (t.startsWith('CHANNEL_') && [...eventKinds].some((k) => k.startsWith('thread_'))))
      ctx.on(t, (d) => handleEvent(t, d));

    // ---------- gap backfill after a fresh IDENTIFY ----------
    ctx.onSessionStart(async () => {
      const self = ctx.bot.userId();
      try {
        const gids = [...new Set(Array.from((ctx.client.guilds as any).keys?.() ?? []))] as string[];
        for (const gid of gids) {
          try { const me: any = await ctx.client.rest.get(`/guilds/${gid}/members/${self}`); myRoles = new Set((me?.roles || []).map(String)); } catch { /* ignore */ }
          let chans: any[] = [];
          try { chans = (await ctx.client.rest.get(`/guilds/${gid}/channels`)) as any[]; } catch (e) { ctx.log.warn('backfill: channel list failed', { guild: gid, error: (e as Error).message }); continue; }
          for (const ch of chans) chanCache.set(String(ch.id), ch);
          for (const ch of chans.filter((x) => TEXTISH.has(x.type))) {
            const cur = cursors.data.channels[ch.id];
            if (!cur) { if (ch.last_message_id) { cursors.data.channels[ch.id] = String(ch.last_message_id); } continue; } // first sight: start from now
          }
        }
        cursors.save();
        if (!includeBackfill) return;
        let total = 0, skipped = 0;
        for (const [cid, after] of Object.entries(cursors.data.channels)) {
          if (total >= backfillMax) break;
          let msgs: any[] = [];
          try { msgs = (await ctx.client.rest.get(`/channels/${cid}/messages?after=${after}&limit=${Math.min(50, backfillMax)}`)) as any[]; }
          catch (e) {
            const msg = (e as Error).message;
            if (/(not|n't|was not) found|unknown channel|404/i.test(msg)) { delete cursors.data.channels[cid]; cursors.save(); ctx.log.info('backfill: dropped cursor for deleted channel', { channel: cid }); }
            else ctx.log.warn('backfill: fetch failed', { channel: cid, error: msg });
            continue;
          }
          msgs.sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : -1));
          for (const m of msgs) {
            if (total >= backfillMax) { skipped++; continue; }
            if (!m.guild_id && chanCache.get(cid)?.guild_id) m.guild_id = chanCache.get(cid).guild_id;
            m.channel_id ??= cid;
            const before = outbox.data.items.length;
            await handle(m, 'create', true);
            if (outbox.data.items.length > before) { total++; st.backfilled++; }
          }
        }
        ctx.log.info('backfill done', { forwarded: total, skipped_over_cap: skipped });
      } catch (e) { ctx.log.warn('backfill error', { error: (e as Error).message }); }
    });

    // ---------- delivery loop ----------
    let wakeFn: (() => void) | null = null; let stopped = false;
    const wake = () => { const f = wakeFn; wakeFn = null; f?.(); };
    const waitWake = (ms: number) => new Promise<void>((r) => { const t = setTimeout(() => { wakeFn = null; r(); }, ms); wakeFn = () => { clearTimeout(t); r(); }; });

    async function post(batch: Item[], extra: Record<string, unknown> = {}, redelivery = false): Promise<{ ok: boolean; status: number; permanent: boolean }> {
      const body = JSON.stringify({
        source: 'fluxer-agent-bridge', schema: 2, owner: ctx.bot.owner, bot: ctx.bot.name, target: ctx.bot.name, test: testFlag,
        delivery_id: idemKey(batch, !!extra.test),
        trust: trustBlock(trustWrap), messages: batch.map((it) => ({ ...(trustWrap ? wrapItem(it) : it), dedupe_key: itemKey(it) })), ...(outbox.data.dropped ? { dropped_due_to_backlog: outbox.data.dropped } : {}),
        ...(redelivery ? { redelivery: true } : {}), ...extra,
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'fluxer-agent-bridge/1.0',
        'Idempotency-Key': idemKey(batch, !!extra.test) };
      if (redelivery) headers['X-Fluxer-Redelivery'] = '1';
      if (auth) headers.Authorization = auth;
      if (legacyKey) headers['X-Automation-Key'] = legacyKey;
      try {
        const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
        await r.arrayBuffer().catch(() => undefined);
        const permanent = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
        return { ok: r.ok, status: r.status, permanent };
      } catch (e) { return { ok: false, status: 0, permanent: false }; }
    }

    // stop-aware sleep: resolves early once teardown starts, so no new batch or retry begins after stop
    const stopWaiters = new Set<() => void>();
    const stopSleep = (ms: number) => new Promise<void>((r) => {
      if (stopped) return r();
      const done = () => { clearTimeout(t); stopWaiters.delete(done); r(); };
      const t = setTimeout(done, ms); stopWaiters.add(done);
    });

    /** One delivery round. Returns false when the loop should back off. */
    async function round(): Promise<boolean> {
      // drop items that already got a 2xx (e.g. a crash after the answer, before the outbox was saved)
      const before = outbox.data.items.length;
      outbox.data.items = outbox.data.items.filter((it) => !deliveredItems.has(itemKey(it)));
      if (outbox.data.items.length !== before) {
        st.skipped_delivered += before - outbox.data.items.length; outbox.flush();
        ctx.log.warn('skipped items already delivered', { count: before - outbox.data.items.length });
      }
      if (!outbox.data.items.length) return true;
      // whole-guild forwarding: cap each POST by count and by size (one oversized message still goes alone)
      const batch: Item[] = []; let bytes = 0;
      for (const it of outbox.data.items.slice(0, maxPerPost)) {
        const n = Buffer.byteLength(JSON.stringify(trustWrap ? wrapItem(it) : it));
        if (batch.length && bytes + n > maxPostBytes) break;
        batch.push(it); bytes += n;
      }
      const key = idemKey(batch);
      if (deliveredKeys.has(key)) {
        outbox.data.items.splice(0, batch.length); outbox.data.inflight = null; outbox.flush();
        st.skipped_delivered += batch.length; ctx.log.warn('skipped a batch whose key already got a 2xx', { count: batch.length });
        return true;
      }
      const prev = outbox.data.inflight;
      const ids = batch.map(itemKey);
      let redelivery = !!prev && prev.unknown && (prev.key === key || ids.some((i) => prev.items.includes(i)));
      let sentAsRedelivery = false;
      let res = { ok: false, status: 0, permanent: false };
      for (let i = 0; i < 5; i++) {
        if (i > 0 && stopped) break;
        outbox.data.inflight = { key, items: ids, at: new Date().toISOString(), unknown: true }; outbox.flush();
        if (redelivery) { st.redelivered++; sentAsRedelivery = true; ctx.log.warn('redelivering a batch whose earlier POST had no answer', { count: batch.length, key }); }
        const p = post(batch, {}, redelivery);
        res = await p;
        if (closed) return true; // teardown already gave up on this POST; a new instance owns the state files now
        if (res.ok || res.permanent) break;
        // a status means the receiver answered without storing it; status 0 = no answer, the receiver may have it
        if (res.status) { outbox.data.inflight = { key, items: ids, at: new Date().toISOString(), unknown: false }; outbox.flush(); }
        redelivery = res.status === 0;
        if (stopped) break;
        await stopSleep(1000 * 2 ** i * (0.75 + Math.random() * 0.5));
      }
      st.posts++;
      if (res.ok) {
        markDelivered(key, batch);
        outbox.data.items.splice(0, batch.length); outbox.data.dropped = 0; outbox.data.inflight = null; outbox.flush();
        st.forwarded += batch.length; st.failedRounds = 0; st.lastError = null; st.lastDelivery = `HTTP ${res.status} at ${new Date().toISOString()}`;
        ctx.log.info('delivered', { count: batch.length, status: res.status, remaining: outbox.data.items.length, ...(sentAsRedelivery ? { redelivery: true } : {}) });
        ctx.emit('bb:delivered', { status: res.status, items: batch });
        refreshHealth();
        return true;
      }
      st.lastError = `HTTP ${res.status || 'network error'} at ${new Date().toISOString()}`;
      if (res.permanent) {
        outbox.data.inflight = null; outbox.flush();
        st.paused = true; st.state = 'paused';
        ctx.log.error('webhook rejected the batch; delivery paused until this bot process restarts', { status: res.status });
        ctx.health.degrade(`webhook HTTP ${res.status}`, 'dnd');
        return true;
      }
      st.failedRounds++;
      ctx.log.warn('delivery round failed', { status: res.status, rounds: st.failedRounds, queued: outbox.data.items.length });
      refreshHealth();
      return false;
    }

    let current: Promise<boolean> | null = null, closed = false;
    async function loop() {
      while (!stopped) {
        if (!url || hold || st.paused || outbox.data.items.length === 0) { await waitWake(60000); continue; }
        await stopSleep(batchMs);
        if (stopped) break; // draining: take no new batch
        current = round();
        const ok = await current;
        current = null;
        if (!ok && !stopped) await waitWake(60000 * (1 + Math.random() * 9));
      }
    }
    function refreshHealth() {
      const n = outbox.data.items.length;
      if (st.paused) return;
      if (st.failedRounds >= 3) ctx.health.degrade(`webhook down, ${n} queued`, 'idle');
      else if (n > outboxMax * 0.8) ctx.health.degrade(`webhook backlog ${n}`, 'idle');
      else ctx.health.clear();
    }
    if (!url) ctx.health.setNote('webhook not configured');
    else if (hold) ctx.health.setNote('webhook held');
    void loop();

    return {
      /** Drain: no new batch starts; an in-flight round gets up to drain_seconds to finish (its 2xx is recorded). */
      async teardown() {
        stopped = true; wake(); for (const f of [...stopWaiters]) f(); stopWaiters.clear();
        if (current) {
          const t0 = Date.now();
          const finished = await Promise.race([current.then(() => true), sleep(drainMs).then(() => false)]);
          ctx.log.info(finished ? 'drained' : 'drain timed out; batch kept for redelivery', { ms: Date.now() - t0, inflight: !!outbox.data.inflight });
        }
        closed = true;
        outbox.flush(); cursors.flush(); delivered.flush(); qualState.flush(); ownState.data.ids = ownIds.keys(); ownState.flush();
      },
    };
  },
});
