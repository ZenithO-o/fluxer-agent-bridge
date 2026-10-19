import http from 'node:http';
import { loadBots, OWNER, type LoadedBot } from './config.js';
import { BotRuntime } from './bot.js';
import { logger } from './log.js';

const log = logger(`${OWNER}/supervisor`);
const HEALTH_PORT = Number(process.env.BB_HEALTH_PORT || 8080);
const NOT_READY_EXIT_MS = Number(process.env.BB_NOT_READY_EXIT_MS || 5 * 60_000);
const STALL_EXIT_MS = 30_000;
const bots = new Map<string, BotRuntime>();
let loadErrors: string[] = [];
const started = Date.now();

async function reconcile() {
  const { bots: specs, errors } = loadBots();
  loadErrors = errors;
  for (const e of errors) log.error('config error', { error: e });
  const want = new Map<string, LoadedBot>(specs.filter((s) => s.config.enabled).map((s) => [s.name, s]));
  for (const [name, rt] of bots) {
    const next = want.get(name);
    if (!next || next.hash !== rt.spec.hash) {
      log.info(next ? 'config changed, restarting bot' : 'bot removed/disabled, stopping', { bot: name });
      await rt.stop();
      bots.delete(name);
    }
  }
  for (const [name, spec] of want) {
    if (bots.has(name)) continue;
    const rt = new BotRuntime(spec);
    bots.set(name, rt);
    log.info('starting bot', { bot: name, plugins: spec.config.plugins.map((p) => p.use) });
    rt.start().catch((e) => log.error('bot start crashed', { bot: name, error: String(e?.message ?? e) }));
  }
  if (!want.size) log.warn('no enabled bots configured');
}

function snapshot() {
  const list = [...bots.values()].map((b) => b.status());
  const required = [...bots.values()].filter((b) => b.state !== 'failed');
  const ok = required.length > 0 && required.every((b) => b.healthy());
  return {
    ok,
    owner: OWNER,
    uptime_s: Math.round((Date.now() - started) / 1000),
    config_errors: loadErrors,
    bots: list,
  };
}

// Loopback only, inside this container's network namespace. Reachable through docker exec, not from the host network.
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/healthz')) {
    const s = snapshot();
    res.writeHead(s.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }
  if (req.method === 'POST' && req.url === '/control') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16384) req.destroy();
    });
    req.on('end', async () => {
      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        const { bot, command, args } = JSON.parse(body || '{}');
        const rt = bots.get(String(bot));
        if (!rt) return send(404, { ok: false, error: `no running bot "${bot}"` });
        const result = await rt.control(String(command), args && typeof args === 'object' ? args : {});
        log.info('control', { bot, command, state: (args as { state?: unknown } | undefined)?.state ?? null });
        send(200, { ok: true, result });
      } catch (e) {
        send(400, { ok: false, error: String((e as Error).message) });
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(HEALTH_PORT, '127.0.0.1', () => {
  log.info('health server listening', { addr: `127.0.0.1:${HEALTH_PORT}` });
});

// Docker does not restart an unhealthy container. Exit so restart: unless-stopped can.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > STALL_EXIT_MS) {
    log.error('event loop stalled, exiting for restart', { stalled_ms: now - lastTick });
    process.exit(1);
  }
  lastTick = now;
  for (const bot of bots.values()) {
    if (bot.state === 'failed' || bot.state === 'stopped') continue;
    const stuck = !bot.healthy() && now - bot.stateSince > NOT_READY_EXIT_MS && now - started > NOT_READY_EXIT_MS;
    if (!stuck) continue;
    log.error('bot not ready too long, exiting for restart', {
      bot: bot.spec.name,
      state: bot.state,
      since_s: Math.round((now - bot.stateSince) / 1000),
    });
    process.exit(1);
  }
}, 5000).unref();

let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal: sig });
  await Promise.race([
    Promise.all([...bots.values()].map((b) => b.stop())),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGUSR2', () => {
  log.warn('SIGUSR2: reconnect drill');
  for (const bot of bots.values()) bot.drillDropSocket();
});
process.on('SIGHUP', () => {
  log.info('SIGHUP: reloading config');
  void reconcile();
});
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: String((e as Error)?.message ?? e) }));

void reconcile();
