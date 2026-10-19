/**
 * Pure forwarding decision for webhook-forward (no I/O, unit-tested in test/forward-filter.test.mjs).
 *
 * Reasons, highest priority first:
 *   "ping"         the bot is @-mentioned (user mention, one of its roles, or @everyone/@here if everyone_is_ping)
 *   "reply-to-bot" message_reference points at one of the bot's own messages
 *   "dm"           direct message (instance has DMs disabled today)
 *   "home"         the channel (or a thread's parent) is in home_channels
 *   "all"          anything else, only in mode = "all"
 * Deletes have no mentions/author: they get "home" or "all" (never ping/reply).
 */
export type Mode = 'all' | 'pings-only' | 'pings-and-home';
export const MODES: readonly Mode[] = ['all', 'pings-only', 'pings-and-home'];
export type Reason = 'ping' | 'reply-to-bot' | 'dm' | 'home' | 'all';

export interface IgnoreOpts { channels: Set<string>; users: Set<string>; bots: boolean; strict: boolean }
export interface FilterOpts {
  mode: Mode;
  selfId: string | null;
  home: Set<string>;
  allow: Set<string>;          // channels = [...] (empty = all visible)
  deny: Set<string>;           // skip_channels = [...] (hard drop, even pings)
  skipAuthors: Set<string>;    // skip_authors = [...] (hard drop, "self" always implied)
  includeDms: boolean;
  includeBots: boolean;        // legacy switch; false = drop every bot/webhook author before anything else
  everyoneIsPing: boolean;
  myRoles: Set<string>;
  ownMessageIds: { has(id: string): boolean };
  ignore: IgnoreOpts;
}
export interface MsgLike {
  id?: string; channel_id?: string; guild_id?: string | null; webhook_id?: string | null;
  author?: { id?: string; bot?: boolean } | null;
  mentions?: Array<{ id?: string }>; mention_roles?: string[]; mention_everyone?: boolean; mention_here?: boolean;
  referenced_message?: { id?: string; author?: { id?: string } } | null;
  message_reference?: { message_id?: string } | null;
}
export type Decision = { forward: true; reason: Reason } | { forward: false; why: string };

const drop = (why: string): Decision => ({ forward: false, why });
const ok = (reason: Reason): Decision => ({ forward: true, reason });

export function toIdSet(v: unknown): Set<string> {
  const arr = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : [];
  return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
}

/** Parse the [plugins.ignore] table (or inline `ignore = { ... }`). Unknown keys are ignored. */
export function parseIgnore(v: unknown): IgnoreOpts {
  const t = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return { channels: toIdSet(t.channels), users: toIdSet(t.users), bots: t.bots === true, strict: t.strict === true };
}

export function isPing(m: MsgLike, o: FilterOpts): boolean {
  const self = o.selfId;
  return (!!self && (m.mentions || []).some((u) => String(u?.id) === self))
    || (m.mention_roles || []).some((r) => o.myRoles.has(String(r)))
    || (o.everyoneIsPing && !!(m.mention_everyone || m.mention_here));
}

export function isReplyToBot(m: MsgLike, o: FilterOpts): boolean {
  const self = o.selfId;
  if (self && m.referenced_message?.author?.id && String(m.referenced_message.author.id) === self) return true;
  const ref = m.message_reference?.message_id ?? m.referenced_message?.id;
  return !!ref && o.ownMessageIds.has(String(ref));
}

/** Decide whether a MESSAGE_CREATE / MESSAGE_UPDATE is forwarded. parentId = thread's parent channel, if any. */
export function decideMessage(m: MsgLike, parentId: string | null, o: FilterOpts): Decision {
  const author = m.author?.id ? String(m.author.id) : '';
  if (!author) return drop('no-author');
  if (author === o.selfId) return drop('self');
  if (o.skipAuthors.has(author)) return drop('skip_authors');
  const botAuthor = !!m.author?.bot || !!m.webhook_id;
  if (botAuthor && !o.includeBots) return drop('include_bots=false');
  const cid = String(m.channel_id ?? '');
  const inSet = (s: Set<string>) => s.has(cid) || (!!parentId && s.has(parentId));

  if (!m.guild_id) {
    if (!o.includeDms) return drop('dm');
  } else {
    if (o.allow.size && !inSet(o.allow)) return drop('not-in-channels');
    if (inSet(o.deny)) return drop('skip_channels');
  }

  const ping = isPing(m, o);
  const reply = !ping && isReplyToBot(m, o);
  const direct = ping || reply;

  // ignore list: drops ambient traffic; pings/replies to the bot still pass unless strict = true
  const ignored = (m.guild_id && inSet(o.ignore.channels)) ? 'ignore.channels'
    : o.ignore.users.has(author) ? 'ignore.users'
    : (o.ignore.bots && botAuthor) ? 'ignore.bots' : null;
  if (ignored && (o.ignore.strict || !direct)) return drop(ignored);

  if (ping) return ok('ping');
  if (reply) return ok('reply-to-bot');
  if (!m.guild_id) return ok('dm');
  if (o.mode === 'pings-and-home' && inSet(o.home)) return ok('home');
  if (o.mode === 'all') return ok(inSet(o.home) ? 'home' : 'all');
  return drop('mode');
}

/** Decide whether a MESSAGE_DELETE is forwarded. authorId/authorBot come from the recent-message cache (may be unknown). */
export function decideDelete(d: { channel_id?: string; guild_id?: string | null }, parentId: string | null,
  author: { id: string; bot: boolean } | null, o: FilterOpts): Decision {
  const cid = String(d.channel_id ?? '');
  const inSet = (s: Set<string>) => s.has(cid) || (!!parentId && s.has(parentId));
  if (author) {
    if (author.id === o.selfId) return drop('self');
    if (o.skipAuthors.has(author.id)) return drop('skip_authors');
    if (author.bot && !o.includeBots) return drop('include_bots=false');
    if (o.ignore.users.has(author.id)) return drop('ignore.users');
    if (o.ignore.bots && author.bot) return drop('ignore.bots');
  }
  if (!d.guild_id) return o.includeDms ? ok('dm') : drop('dm');
  if (o.allow.size && !inSet(o.allow)) return drop('not-in-channels');
  if (inSet(o.deny)) return drop('skip_channels');
  if (inSet(o.ignore.channels)) return drop('ignore.channels');
  if (inSet(o.home) && o.mode !== 'pings-only') return ok('home');
  if (o.mode === 'all') return ok('all');
  return drop('mode');
}

/** Bounded insertion-ordered map (LRU-ish): recent message id -> author, own message ids. */
export class BoundedMap<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  set(k: string, v: V) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
  get(k: string) { return this.m.get(k); }
  has(k: string) { return this.m.has(k); }
  delete(k: string) { this.m.delete(k); }
  get size() { return this.m.size; }
  keys() { return [...this.m.keys()]; }
}

// ---------------------------------------------------------------------------------------------------------------
// Opt-in non-message events (webhook-forward `events = [...]`).
export const EVENT_KINDS = ['reaction_add', 'reaction_remove', 'member_join', 'member_leave', 'member_update',
  'thread_create', 'thread_update', 'thread_delete', 'channel_create', 'channel_update', 'channel_delete',
  'ban_add', 'ban_remove', 'typing'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
const ALIASES: Record<string, EventKind[]> = {
  reactions: ['reaction_add', 'reaction_remove'],
  members: ['member_join', 'member_leave', 'member_update'],
  threads: ['thread_create', 'thread_update', 'thread_delete'],
  channels: ['channel_create', 'channel_update', 'channel_delete'],
  bans: ['ban_add', 'ban_remove'],
};
/** Gateway dispatch -> event kind. CHANNEL_* for a thread-type channel is reported as thread_* (Fluxer may use either). */
export const GATEWAY_EVENTS: Record<string, EventKind> = {
  MESSAGE_REACTION_ADD: 'reaction_add', MESSAGE_REACTION_REMOVE: 'reaction_remove',
  MESSAGE_REACTION_REMOVE_ALL: 'reaction_remove', MESSAGE_REACTION_REMOVE_EMOJI: 'reaction_remove',
  GUILD_MEMBER_ADD: 'member_join', GUILD_MEMBER_REMOVE: 'member_leave', GUILD_MEMBER_UPDATE: 'member_update',
  THREAD_CREATE: 'thread_create', THREAD_UPDATE: 'thread_update', THREAD_DELETE: 'thread_delete',
  CHANNEL_CREATE: 'channel_create', CHANNEL_UPDATE: 'channel_update', CHANNEL_DELETE: 'channel_delete',
  GUILD_BAN_ADD: 'ban_add', GUILD_BAN_REMOVE: 'ban_remove', TYPING_START: 'typing',
};
export const THREAD_TYPES = new Set([10, 11, 12]);

export function parseEvents(v: unknown): { kinds: Set<EventKind>; unknown: string[] } {
  const kinds = new Set<EventKind>(); const unknown: string[] = [];
  for (const raw of toIdSet(v)) {
    const k = raw.toLowerCase().replace(/[-\s]/g, '_');
    if (ALIASES[k]) ALIASES[k].forEach((x) => kinds.add(x));
    else if ((EVENT_KINDS as readonly string[]).includes(k)) kinds.add(k as EventKind);
    else unknown.push(raw);
  }
  return { kinds, unknown };
}

export interface EventInfo { channelId: string | null; parentId: string | null; guildId: string | null; actor: { id: string; bot: boolean } | null; toBot: boolean }
/** Reason/ignore handling for non-message events. Returns reason "reaction-to-bot" for reactions on the bot's own messages. */
export function decideEvent(kind: EventKind, e: EventInfo, o: FilterOpts): { forward: true; reason: string } | { forward: false; why: string } {
  if (e.actor) {
    if (e.actor.id === o.selfId) return { forward: false, why: 'self' };
    if (o.skipAuthors.has(e.actor.id)) return { forward: false, why: 'skip_authors' };
    if (e.actor.bot && !o.includeBots) return { forward: false, why: 'include_bots=false' };
  }
  const cid = e.channelId ?? '';
  const inSet = (s: Set<string>) => (!!cid && s.has(cid)) || (!!e.parentId && s.has(e.parentId));
  if (cid && o.allow.size && !inSet(o.allow)) return { forward: false, why: 'not-in-channels' };
  if (cid && inSet(o.deny)) return { forward: false, why: 'skip_channels' };
  const ignored = (cid && inSet(o.ignore.channels)) ? 'ignore.channels'
    : (e.actor && o.ignore.users.has(e.actor.id)) ? 'ignore.users'
    : (e.actor && o.ignore.bots && e.actor.bot) ? 'ignore.bots' : null;
  if (ignored && (o.ignore.strict || !e.toBot)) return { forward: false, why: ignored };
  if (e.toBot) return { forward: true, reason: kind.startsWith('reaction') ? 'reaction-to-bot' : 'ping' };
  if (cid && inSet(o.home)) return { forward: true, reason: 'home' };
  return { forward: true, reason: 'all' };
}

/** NICK = guild nickname, else global display name, else username. */
export function nickOf(author: any, member?: any): string | null {
  return member?.nick || author?.nick || author?.global_name || author?.username || null;
}
