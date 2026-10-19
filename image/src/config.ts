import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

export const CFG_DIR = process.env.BB_CFG_DIR || '/cfg';      // owners/<owner> mounted read-only
export const STATE_DIR = process.env.BB_STATE_DIR || '/state'; // state/<owner>
export const OWNER = process.env.BB_OWNER || 'unknown';
/** Base URL of your Fluxer instance (discovery at <INSTANCE>/.well-known/fluxer). Set FLUXER_INSTANCE in bridge.env. */
export const INSTANCE = process.env.FLUXER_INSTANCE || 'https://your-fluxer.example';

export interface PluginSpec { use: string; [k: string]: unknown }
export interface BotConfig {
  name: string;
  enabled: boolean;
  presence: { status: 'online' | 'idle' | 'dnd'; text?: string };
  ignored_events: string[];
  prefix: string;
  plugins: PluginSpec[];
}
export interface LoadedBot { name: string; dir: string; config: BotConfig; secrets: Record<string, string>; hash: string }

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || !l.includes('=')) continue;
    const i = l.indexOf('=');
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const NAME_RE = /^[a-z0-9_]{1,32}$/;

export function loadBots(): { bots: LoadedBot[]; errors: string[] } {
  const bots: LoadedBot[] = []; const errors: string[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(CFG_DIR); } catch (e) { errors.push(`cannot read ${CFG_DIR}: ${(e as Error).message}`); }
  for (const name of entries.sort()) {
    const dir = path.join(CFG_DIR, name);
    if (!NAME_RE.test(name) || !fs.statSync(dir).isDirectory()) continue;
    const tomlPath = path.join(dir, 'bot.toml');
    if (!fs.existsSync(tomlPath)) continue;
    try {
      const tomlText = fs.readFileSync(tomlPath, 'utf8');
      const secText = fs.existsSync(path.join(dir, 'secrets.env')) ? fs.readFileSync(path.join(dir, 'secrets.env'), 'utf8') : '';
      const t = parseToml(tomlText) as Record<string, any>;
      const config: BotConfig = {
        name,
        enabled: t.enabled !== false,
        presence: { status: t.presence?.status ?? 'online', text: t.presence?.text },
        ignored_events: Array.isArray(t.ignored_events) ? t.ignored_events.map(String) : ['TYPING_START'],
        prefix: typeof t.prefix === 'string' ? t.prefix : '!',
        plugins: Array.isArray(t.plugins) ? t.plugins : [],
      };
      const hash = crypto.createHash('sha256').update(tomlText).update('\0').update(secText).digest('hex').slice(0, 16);
      bots.push({ name, dir, config, secrets: parseEnvFile(secText), hash });
    } catch (e) { errors.push(`${name}: ${(e as Error).message}`); }
  }
  return { bots, errors };
}
