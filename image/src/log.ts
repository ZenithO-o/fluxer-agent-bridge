// Structured JSON logs. Never pass tokens, webhook URLs/keys or message bodies here.
export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
const SECRET_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{30,}/g; // bot token shape, defensive scrub

export function log(level: Level, scope: string, msg: string, extra: Record<string, unknown> = {}) {
  if (ORDER[level] < MIN) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...extra });
  process.stdout.write(line.replace(SECRET_RE, '<redacted>') + '\n');
}
export const logger = (scope: string) => ({
  debug: (m: string, e?: Record<string, unknown>) => log('debug', scope, m, e),
  info: (m: string, e?: Record<string, unknown>) => log('info', scope, m, e),
  warn: (m: string, e?: Record<string, unknown>) => log('warn', scope, m, e),
  error: (m: string, e?: Record<string, unknown>) => log('error', scope, m, e),
});
export type Logger = ReturnType<typeof logger>;
