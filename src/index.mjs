import 'dotenv/config';
import { CONFIG } from './config.mjs';
import { startWatcher } from './watcher.mjs';

console.log('🔧 Config:', {
  chain: CONFIG.CHAIN_NAME,
  vault: CONFIG.VAULT,
  ws: CONFIG.WS_URL ? 'ws ok' : 'missing',
  http: CONFIG.HTTP_URL ? 'http ok' : 'missing',
  backfill: CONFIG.BACKFILL_BLOCKS,
  tg: CONFIG.TELEGRAM.TOKEN ? 'on' : 'off',
  discord: CONFIG.DISCORD.WEBHOOK_URL ? 'on' : 'off'
});

// Optional tiny health server for Railway
const HEALTH_PORT = process.env.HEALTH_PORT || process.env.PORT;
if (HEALTH_PORT) {
  const server = await import('node:http').then(m => m.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
  }));
  server.listen(HEALTH_PORT, () => console.log(`🫀 Health on :${HEALTH_PORT}`));
}

(async () => {
  try {
    await startWatcher();
    console.log('👂 Event watcher started');
  } catch (e) {
    console.error('❌ Failed to start watcher:', e?.message || e);
    process.exit(1);
  }
})();

// Keep alive in some PaaS
setInterval(() => {}, 60_000);

