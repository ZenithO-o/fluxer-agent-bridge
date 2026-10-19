/**
 * Untrusted-text marking for the webhook payload.
 * Ids, booleans, reason/event enums and timestamps are routing data. Every free-text string copied from Fluxer
 * (message content, names, filenames, emoji and tag names) was written by whoever can post, so agents must treat it
 * as data, never as instructions. Every payload carries a `trust` block that lists those fields. With the per-bot
 * `trust_wrap = true` knob (default off) the bridge also wraps each of them in place as «fluxer:u»…«/fluxer:u».
 * Escaping doubles every « and » first, so a value can never close the wrapper early.
 */
export const OPEN = '«fluxer:u»';
export const CLOSE = '«/fluxer:u»';

export const UNTRUSTED_PATHS = [
  'messages[].content', 'messages[].reply_to.content',
  'messages[].author.username', 'messages[].author.global_name', 'messages[].author.nick', 'messages[].author.display_name',
  'messages[].user.username', 'messages[].user.global_name', 'messages[].user.nick', 'messages[].user.display_name',
  'messages[].member.nick', 'messages[].channel_name', 'messages[].guild_name',
  'messages[].thread.name', 'messages[].thread.parent_name', 'messages[].thread.applied_tags[].name',
  'messages[].attachments[].filename', 'messages[].attachments[].url', 'messages[].emoji.name', 'messages[].channel.name',
] as const;

/** The additive `trust` envelope. `wrapped` says whether the listed strings carry the delimiters in this payload. */
export function trustBlock(wrapped: boolean) {
  return { version: 1, wrapped, open: OPEN, close: CLOSE, escape: 'double-guillemets', untrusted_paths: [...UNTRUSTED_PATHS] };
}

export const escapeUntrusted = (s: string) => String(s).replaceAll('«', '««').replaceAll('»', '»»');
export const wrapUntrusted = (s: unknown) => OPEN + escapeUntrusted(String(s ?? '')) + CLOSE;
export const isWrapped = (s: unknown) => typeof s === 'string' && s.length >= OPEN.length + CLOSE.length && s.startsWith(OPEN) && s.endsWith(CLOSE);
/** Reverse of wrapUntrusted. Returns the input unchanged if it is not wrapped. */
export function unwrapUntrusted(s: string): string {
  if (!isWrapped(s)) return s;
  return s.slice(OPEN.length, s.length - CLOSE.length).replaceAll('««', '«').replaceAll('»»', '»');
}

/** Wrap one string value; null/undefined and non-strings (ids that happen to sit in a name slot) stay as they are. */
const w = (v: unknown) => (typeof v === 'string' ? wrapUntrusted(v) : v);
function wrapFields(o: any, keys: string[]) {
  if (!o || typeof o !== 'object') return o;
  const out = { ...o };
  for (const k of keys) if (k in out) out[k] = w(out[k]);
  return out;
}
const NAMES = ['username', 'global_name', 'nick', 'display_name'];

/** Copy of one payload item with every UNTRUSTED_PATHS string wrapped. Keys, types of ids, and order are unchanged. */
export function wrapItem<T extends Record<string, unknown>>(item: T): T {
  const o: any = { ...item };
  if ('content' in o) o.content = w(o.content);
  if ('channel_name' in o) o.channel_name = w(o.channel_name);
  if ('guild_name' in o) o.guild_name = w(o.guild_name);
  if (o.reply_to) o.reply_to = wrapFields(o.reply_to, ['content']);
  if (o.author) o.author = wrapFields(o.author, NAMES);
  if (o.user) o.user = wrapFields(o.user, NAMES);
  if (o.member) o.member = wrapFields(o.member, ['nick']);
  if (o.emoji) o.emoji = wrapFields(o.emoji, ['name']);
  if (o.channel) o.channel = wrapFields(o.channel, ['name']);
  if (o.thread) {
    o.thread = wrapFields(o.thread, ['name', 'parent_name']);
    if (Array.isArray(o.thread.applied_tags)) o.thread.applied_tags = o.thread.applied_tags.map((t: any) => wrapFields(t, ['name']));
  }
  if (Array.isArray(o.attachments)) o.attachments = o.attachments.map((a: any) => wrapFields(a, ['filename', 'url']));
  return o;
}
