import { definePlugin } from '../plugin.js';
import { ActivityMachine } from './activity-machine.js';
import { BoundedMap, nickOf } from './forward-filter.js';

/**
 * activity-status: the bot's custom status shows what it is doing (opt-in per bot via [[plugins]] use = "activity-status").
 * Inputs: webhook-forward's "bb:delivered" (webhook 2xx) -> Reading; Responding from either
 *   (a) the bot's own TYPING_START (any agent: POST /api/v1/channels/<id>/typing with its own bot token; NICK = last
 *       author in that channel), or (b) the loopback control command "activity" (bin/status.sh, examples/agent_post.py, examples/fab-status.py;
 *       can name the exact message/user); and the gateway MESSAGE_CREATE authored by the bot itself -> Responded.
 * Needs TYPING_START delivered: bot.ts drops it from ignored_events when typing_means_responding is on (default).
 * Health always wins (bot.ts presenceOptions): a degraded/broken state replaces the activity text.
 */
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

export default definePlugin({
  name: 'activity-status',
  setup(ctx) {
    const c = ctx.config;
    const m = new ActivityMachine({
      readingMs: num(c.reading_seconds, 120) * 1000,
      respondingMs: num(c.responding_seconds, 120) * 1000,
      respondedMs: num(c.responded_seconds, 20) * 1000,
    });
    const idleText = typeof c.idle_text === 'string' && c.idle_text ? c.idle_text : null; // null = bot presence.text
    ctx.presence.setRate(num(c.min_update_seconds, 2) * 1000, num(c.max_updates_per_minute, 12));

    const msgAuthor = new BoundedMap<{ id: string; nick: string | null }>(5000); // message id -> author
    const userNick = new BoundedMap<string>(2000);                             // user id -> NICK
    const lastInChannel = new BoundedMap<string>(500);                         // channel id -> last non-self author NICK
    const repliedTo = new BoundedMap<true>(1000);                              // message ids we already posted a reply to
    const typingResponds = c.typing_means_responding !== false;
    const transitions: Record<string, number> = {};
    let timer: NodeJS.Timeout | null = null;

    function apply(kind: string) {
      transitions[kind] = (transitions[kind] ?? 0) + 1;
      const v = m.view();
      ctx.presence.setActivity(v.text ?? idleText);
      if (timer) { clearTimeout(timer); timer = null; }
      if (v.until !== null) timer = setTimeout(() => { if (m.expire()) apply('idle'); }, Math.max(0, v.until - Date.now()) + 50);
      ctx.log.info('activity', { state: v.state, via: kind });
    }

    async function guildOf(channelId?: string | null): Promise<string | null> {
      if (channelId) { try { const ch: any = await ctx.client.rest.get(`/channels/${channelId}`); if (ch?.guild_id) return String(ch.guild_id); } catch { /* ignore */ } }
      const g = Array.from((ctx.client.guilds as any)?.keys?.() ?? []) as string[];
      return g[0] ?? null;
    }
    async function nickForUser(uid: string, channelId?: string | null): Promise<string | null> {
      if (userNick.has(uid)) return userNick.get(uid)!;
      const gid = await guildOf(channelId);
      try {
        const mem: any = gid ? await ctx.client.rest.get(`/guilds/${gid}/members/${uid}`) : null;
        const n = nickOf(mem?.user, mem); if (n) { userNick.set(uid, n); return n; }
      } catch { /* ignore */ }
      try { const u: any = await ctx.client.rest.get(`/users/${uid}`); const n = nickOf(u); if (n) { userNick.set(uid, n); return n; } } catch { /* ignore */ }
      return null;
    }
    async function nickForMessage(mid: string, channelId?: string | null): Promise<string | null> {
      const known = msgAuthor.get(mid);
      if (known) return known.nick ?? (await nickForUser(known.id, channelId));
      if (!channelId) return null;
      try {
        const msg: any = await ctx.client.rest.get(`/channels/${channelId}/messages/${mid}`);
        if (msg?.author?.id) return msg.member?.nick || (await nickForUser(String(msg.author.id), channelId)) || nickOf(msg.author);
      } catch { /* ignore */ }
      return null;
    }

    /** Last non-self author's NICK in a channel: cache, else one REST read of the latest messages. */
    async function lastAuthorIn(channelId: string): Promise<string | null> {
      const hit = lastInChannel.get(channelId); if (hit) return hit;
      try {
        const msgs = (await ctx.client.rest.get(`/channels/${channelId}/messages?limit=10`)) as any[];
        const self = ctx.bot.userId();
        const last = (msgs || []).find((x) => x?.author?.id && String(x.author.id) !== self);
        if (!last) return null;
        const n = last.member?.nick || (await nickForUser(String(last.author.id), channelId)) || nickOf(last.author);
        if (n) lastInChannel.set(channelId, n);
        return n;
      } catch { return null; }
    }

    ctx.on('MESSAGE_CREATE', async (d) => {
      if (!d?.id || !d.author?.id) return;
      const self = ctx.bot.userId();
      const nick = nickOf(d.author, d.member);
      msgAuthor.set(String(d.id), { id: String(d.author.id), nick });
      if (String(d.author.id) !== self) {
        if (nick) { userNick.set(String(d.author.id), nick); if (d.channel_id) lastInChannel.set(String(d.channel_id), nick); }
        return;
      }
      // Our own message accepted by the API -> Responded.
      const ref = d.message_reference?.message_id ?? d.referenced_message?.id;
      let target: string | null = null;
      const ra = d.referenced_message?.author;
      if (ra?.id) target = d.referenced_message.member?.nick || (await nickForUser(String(ra.id), d.channel_id)) || nickOf(ra);
      else if (ref) target = await nickForMessage(String(ref), d.message_reference?.channel_id ?? d.channel_id);
      if (ref) repliedTo.set(String(ref), true);
      m.responded(target);
      apply('responded');
    });

    if (typingResponds) ctx.on('TYPING_START', async (d) => {
      const self = ctx.bot.userId();
      const uid = d?.user_id ?? d?.member?.user?.id;
      if (!self || String(uid) !== self) return;
      const v = m.view();
      if (v.state === 'responding') return; // a precise control command already set it
      const nick = d.channel_id ? await lastAuthorIn(String(d.channel_id)) : null;
      if (m.view().state === 'responding') return; // a control command landed while we looked it up
      if (m.responding(nick).applied) apply('typing:responding');
    });

    ctx.on('bb:delivered', (d: any) => {
      const items = (d?.items ?? []).filter((it: any) => (it.event === 'create' || it.event === 'edit') && it.author?.id && !it.test);
      if (!items.length) return;
      const changed = m.reading(items.map((it: any) => ({ authorId: String(it.author.id), nick: nickOf(it.author) ?? 'someone' })));
      if (changed) apply('reading');
    });

    ctx.control('activity', async (a) => {
      const state = String(a.state ?? 'show');
      if (state === 'show') return { ...m.view(), presence: ctx.presence.current(), transitions };
      if (state === 'idle') { m.toIdle(); apply('control:idle'); return { ...m.view(), presence: ctx.presence.current() }; }
      if (state !== 'responding') throw new Error('state must be responding | idle | show');
      const channel = a.channel ? String(a.channel) : null;
      let nick: string | null = null;
      if (a.message) nick = await nickForMessage(String(a.message), channel);
      if (!nick && a.user) nick = await nickForUser(String(a.user), channel);
      if (!nick && typeof a.nick === 'string' && a.nick.trim()) nick = a.nick.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
      if (!nick && channel) nick = await lastAuthorIn(channel);
      if (a.message && repliedTo.has(String(a.message))) return { applied: false, reason: 'stale (already replied to that message)', nick, ...m.view() };
      const at = typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : undefined;
      const r = m.responding(nick, at);
      if (r.applied) apply('control:responding');
      return { ...r, nick, ...m.view() };
    });

    ctx.status(() => ({ ...m.view(), idle_text: idleText, transitions }));
    apply('start');
    return { teardown() { if (timer) clearTimeout(timer); } };
  },
});
