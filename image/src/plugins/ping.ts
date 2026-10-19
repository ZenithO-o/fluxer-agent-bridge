import { definePlugin } from '../plugin.js';
// `!ping` replies with gateway latency and uptime. Smoke-test plugin; enable only on bots meant to talk.
export default definePlugin({
  name: 'ping',
  setup(ctx) {
    const started = Date.now();
    ctx.command('ping', {
      description: 'latency and uptime',
      handler: async (c) => {
        let rtt = -1; try { rtt = ctx.client.ws.ping; } catch { /* not connected */ }
        await c.reply(`pong (${rtt} ms, up ${Math.round((Date.now() - started) / 60000)} min)`);
      },
    });
  },
});
