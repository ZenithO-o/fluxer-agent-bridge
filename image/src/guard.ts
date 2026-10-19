/**
 * Optional guild check for writes. Without a context a write is not checked (cross-server posts are legitimate).
 * With a context (a guild id, or DM) the target channel is resolved first (GET /channels/{id}; a thread inherits its
 * guild) and anything unknown or mismatched is refused before any write. Strict mode (FLUXER_REQUIRE_GUILD=1, or
 * require_guild = true in the bot's bot.toml for `cli.js post`) also refuses a write with no context.
 */
export type PostCtx = { guild: string } | { dm: true };
const SNOWFLAKE = /^\d{5,25}$/;
const DM_TYPES = new Set([1, 3]);

export const truthy = (v: unknown) => v === true || /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/** null = no context, so no check. guild "dm" is the same as dm = true, so a copied `guild` value always works. */
export function parseCtx(guild?: string | null, dm?: boolean, envValue?: string | null, strict = false): PostCtx | null | { error: string } {
  let g = (guild ?? '').trim();
  if (g.toLowerCase() === 'dm') { g = ''; dm = true; }
  if (g && dm) return { error: 'refused: pass --guild or --dm, not both' };
  if (dm) return { dm: true };
  if (g) return SNOWFLAKE.test(g) ? { guild: g } : { error: `refused: bad guild id ${g}` };
  const e = (envValue ?? '').trim();
  if (e) return parseCtx(e, false, null);
  return strict ? { error: 'refused: no context guild (strict mode; pass --guild ID or --dm)' } : null;
}

/** null = allowed; otherwise a short refusal. `ch` null/undefined means the channel could not be resolved. */
export function checkTarget(channelId: string, ch: any, ctx: PostCtx, parent?: any): string | null {
  if (!ch || typeof ch !== 'object') return `refused: channel ${channelId} not resolvable`;
  const guild = ch.guild_id ? String(ch.guild_id) : parent?.guild_id ? String(parent.guild_id) : null;
  if ('dm' in ctx) return !guild && DM_TYPES.has(Number(ch.type)) ? null : `refused: channel ${channelId} is not a DM`;
  if (!guild) return `refused: channel ${channelId} has no guild (context ${ctx.guild})`;
  return guild === ctx.guild ? null : `refused: channel ${channelId} is in guild ${guild}, context is ${ctx.guild}`;
}

/** Resolve a channel (and a parent when the guild must come from it), then check. */
export async function guard(get: (p: string) => Promise<any>, channelId: string, ctx: PostCtx): Promise<string | null> {
  if (!SNOWFLAKE.test(channelId)) return `refused: bad channel id ${channelId}`;
  let ch: any = null, parent: any = null;
  try { ch = await get(`/channels/${channelId}`); } catch { ch = null; }
  if (ch && !ch.guild_id && ch.parent_id) { try { parent = await get(`/channels/${ch.parent_id}`); } catch { parent = null; } }
  return checkTarget(channelId, ch, ctx, parent);
}
