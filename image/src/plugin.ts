import type { Client } from '@fluxerjs/core';
import type { Logger } from './log.js';
import type { BotConfig } from './config.js';

/** Raw gateway dispatch as Fluxer sends it (op 0). */
export interface Dispatch { t: string; s: number | null; d: any }

export interface CommandContext {
  message: any;            // raw MESSAGE_CREATE payload
  args: string[];
  reply: (content: string) => Promise<void>;
}
export interface CommandSpec { description?: string; perms?: string[]; handler: (c: CommandContext) => Promise<void> }

export interface PluginContext {
  client: Client;
  bot: { name: string; owner: string; userId: () => string | null; config: BotConfig };
  config: Record<string, unknown>;     // this plugin's [[plugins]] table
  secrets: Readonly<Record<string, string>>; // this bot's secrets.env only
  log: Logger;
  stateDir: string;                    // state/<bot>/<plugin>/ (writable)
  /** Subscribe to raw dispatches (MESSAGE_CREATE, GUILD_MEMBER_ADD, ...). Replayed events after RESUME arrive here too. */
  on(event: string, fn: (d: any, dispatch: Dispatch) => void | Promise<void>): void;
  /** Called after every fresh IDENTIFY (READY), not after RESUMED; use it to backfill a gap. */
  onSessionStart(fn: (info: { resumed: false; firstStart: boolean }) => void | Promise<void>): void;
  /** Prefix command (stands in for slash commands, which Fluxer does not have). */
  command(name: string, spec: CommandSpec): void;
  /** Health feeds presence: degrade('webhook backlog 12', 'idle'|'dnd'), clear(). */
  health: { degrade(reason: string, level?: 'idle' | 'dnd'): void; clear(): void; setNote(note: string | null): void };
  /** Expose plugin status in /healthz. */
  status(fn: () => Record<string, unknown>): void;
  /** Internal plugin-to-plugin events (names start with "bb:", e.g. "bb:delivered"); handlers subscribe with on(). */
  emit(event: `bb:${string}`, data: unknown): void;
  /** Control command reachable only from inside the container (cli.js control/activity -> 127.0.0.1 health server). */
  control(name: string, fn: (args: Record<string, unknown>) => unknown | Promise<unknown>): void;
  /**
   * Activity text shown in the custom status when the bot is healthy (null = idle/configured text).
   * Health always wins: any degradation (idle/dnd + reason) or note replaces it.
   * setRate: presence coalescing (min gap between updates, max updates per rolling minute).
   */
  presence: { setActivity(text: string | null): void; setRate(minGapMs: number, maxPerMinute: number): void; current(): { status: string; text: string | null } };
}

export interface PluginInstance { teardown?(): void | Promise<void> }
export interface PluginDef {
  name: string;
  setup(ctx: PluginContext): PluginInstance | void | Promise<PluginInstance | void>;
}
export const definePlugin = (p: PluginDef) => p;
