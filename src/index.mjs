// src/index.mjs
// UPDATED: Multi-chain support - starts watchers for all enabled chains

if (process.env.NODE_ENV !== 'production') {
  try {
    await import('dotenv/config');
  } catch {}
}

import { CONFIG } from './config.mjs';
import { startWatcher } from './watcher.mjs';

console.log('═══════════════════════════════════════════════════════════');
console.log('  🔗 RewardSwapper Event Bot');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Show enabled chains
// ═══════════════════════════════════════════════════════════════════════════
if (CONFIG.CHAINS.length > 0) {
  console.log(`📋 Multi-chain mode: ${CONFIG.CHAINS.length} chain(s) enabled`);
  for (const chain of CONFIG.CHAINS) {
    console.log(`   ${chain.emoji} ${chain.name} - ${chain.rewardSwapper}`);
  }
} else {
  // Fallback to legacy single-chain mode
  console.log('📋 Single-chain mode (legacy)');
  console.log(`   Chain: ${CONFIG.CHAIN_NAME}`);
  console.log(`   Swapper: ${CONFIG.REWARD_SWAPPER}`);
}
console.log('');

// Show notification config
console.log('📣 Notifications:');
console.log(`   Telegram: ${CONFIG.TELEGRAM.TOKEN ? '✅ enabled' : '❌ disabled'}`);
console.log(`   Discord:  ${CONFIG.DISCORD.WEBHOOK_URL ? '✅ enabled' : '❌ disabled'}`);
console.log('');

// Show shared config
console.log('⚙️  Settings:');
console.log(`   Backfill blocks: ${CONFIG.BACKFILL_BLOCKS}`);
console.log(`   Confirmations:   ${CONFIG.CONFIRMATIONS}`);
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

// Optional health server for Railway/Render
const HEALTH_PORT = process.env.HEALTH_PORT || process.env.PORT;
if (HEALTH_PORT) {
  const server = await import('node:http').then(m => m.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      ts: Date.now(),
      chains: CONFIG.CHAINS.map(c => ({ key: c.key, name: c.name })),
    }));
  }));
  server.listen(HEALTH_PORT, () => console.log(`🫀 Health on :${HEALTH_PORT}`));
}

(async () => {
  try {
    // ═══════════════════════════════════════════════════════════════════════
    // NEW: Multi-chain startup
    // ═══════════════════════════════════════════════════════════════════════
    if (CONFIG.CHAINS.length > 0) {
      // Start all chain watchers in parallel
      const results = await Promise.allSettled(
        CONFIG.CHAINS.map(chain => startWatcher(chain))
      );
      
      let successCount = 0;
      let failedChains = [];
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const chain = CONFIG.CHAINS[i];
        
        if (result.status === 'fulfilled') {
          successCount++;
        } else {
          failedChains.push({
            chain: chain.name,
            error: result.reason?.message || result.reason,
          });
          console.error(`❌ Failed to start ${chain.emoji} ${chain.name}:`, result.reason?.message || result.reason);
        }
      }
      
      console.log('');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🚀 Started ${successCount}/${CONFIG.CHAINS.length} chain watchers`);
      if (failedChains.length > 0) {
        console.log(`⚠️  Failed: ${failedChains.map(f => f.chain).join(', ')}`);
      }
      console.log('═══════════════════════════════════════════════════════════');
      
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // Legacy single-chain mode (backwards compatible)
      // ═══════════════════════════════════════════════════════════════════════
      if (!CONFIG.WS_URL || !CONFIG.HTTP_URL) {
        console.error('❌ No chains configured!');
        console.error('   Set RPC URLs like: BASE_RPC_WS_URL=wss://... BASE_RPC_HTTP_URL=https://...');
        console.error('   Or use legacy: RPC_WS_URL=wss://... RPC_HTTP_URL=https://...');
        process.exit(1);
      }
      
      await startWatcher(); // No chainConfig = use legacy CONFIG values
      console.log('👂 Event watcher started (legacy single-chain mode)');
    }
  } catch (e) {
    console.error('❌ Failed to start watcher:', e?.message || e);
    process.exit(1);
  }
})();

// Keep alive
setInterval(() => {}, 60_000);

// Hardening
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('SIGTERM', () => {
  console.warn('[Signal] SIGTERM received, exiting…');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.warn('[Signal] SIGINT received, exiting…');
  process.exit(0);
});