// src/config.mjs
// UPDATED: Added multi-chain support

if (process.env.NODE_ENV !== 'production') {
  try {
    await import('dotenv/config');
  } catch {}
}
import fs from 'node:fs';

function req(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Chain definitions for all supported networks
// ═══════════════════════════════════════════════════════════════════════════
const CHAIN_DEFINITIONS = {
  base: {
    id: 8453,
    name: 'Base',
    emoji: '🔵',
    explorerBase: 'https://basescan.org',
    llamaChain: 'base',
    rewardSwapper: '0x25f11f947309df89bf4d36da5d9a9fb5f1e186c1',
    // Base-specific: also monitor Vault and Pools
    vault: process.env.VAULT_ADDRESS || null,
    pools: [
      { 
        address: '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd', 
        name: 'iAERO/AERO',
        token0: { symbol: 'iAERO', decimals: 18 },
        token1: { symbol: 'AERO', decimals: 18 }
      },
      { 
        address: '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4', 
        name: 'LIQ/USDC',
        token0: { symbol: 'LIQ', decimals: 18 },
        token1: { symbol: 'USDC', decimals: 6 }
      },
      { 
        address: '0xa1b79a66994878476a9dcb20e50969a7d641229c', 
        name: 'iAERO/AERO (CL)',
        token0: { symbol: 'iAERO', decimals: 18 },
        token1: { symbol: 'AERO', decimals: 18 }
      },
    ],
    stablecoins: {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
    },
  },
  ethereum: {
    id: 1,
    name: 'Ethereum',
    emoji: '🔷',
    explorerBase: 'https://etherscan.io',
    llamaChain: 'ethereum',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  arbitrum: {
    id: 42161,
    name: 'Arbitrum',
    emoji: '🔶',
    explorerBase: 'https://arbiscan.io',
    llamaChain: 'arbitrum',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  optimism: {
    id: 10,
    name: 'Optimism',
    emoji: '🔴',
    explorerBase: 'https://optimistic.etherscan.io',
    llamaChain: 'optimism',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  polygon: {
    id: 137,
    name: 'Polygon',
    emoji: '🟣',
    explorerBase: 'https://polygonscan.com',
    llamaChain: 'polygon',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  bsc: {
    id: 56,
    name: 'BNB Chain',
    emoji: '🟡',
    explorerBase: 'https://bscscan.com',
    llamaChain: 'bsc',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  avalanche: {
    id: 43114,
    name: 'Avalanche',
    emoji: '🔺',
    explorerBase: 'https://snowtrace.io',
    llamaChain: 'avax',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  scroll: {
    id: 534352,
    name: 'Scroll',
    emoji: '📜',
    explorerBase: 'https://scrollscan.com',
    llamaChain: 'scroll',
    rewardSwapper: '0x75f57Faf06f0191a1422a665BFc297bcb6Aa765a',
    vault: null,
    pools: [],
    stablecoins: {},
  },
  linea: {
    id: 59144,
    name: 'Linea',
    emoji: '➖',
    explorerBase: 'https://lineascan.build',
    llamaChain: 'linea',
    rewardSwapper: '0x679e6e600E480d99f8aeD8555953AD2cF43bAB96', // Different address
    vault: null,
    pools: [],
    stablecoins: {},
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Helper to get RPC URLs for a chain from env vars
// ═══════════════════════════════════════════════════════════════════════════
function getChainRpcUrls(chainKey) {
  const upper = chainKey.toUpperCase();
  
  // Try multiple env var patterns for flexibility
  const wsPatterns = [`${upper}_RPC_WS_URL`, `${upper}_WS_URL`, `RPC_WS_URL_${upper}`];
  const httpPatterns = [`${upper}_RPC_HTTP_URL`, `${upper}_HTTP_URL`, `RPC_HTTP_URL_${upper}`];
  
  let wsUrl = null, httpUrl = null;
  
  for (const p of wsPatterns) if (process.env[p]) { wsUrl = process.env[p]; break; }
  for (const p of httpPatterns) if (process.env[p]) { httpUrl = process.env[p]; break; }
  
  return { wsUrl, httpUrl };
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Get list of enabled chains (those with valid RPC URLs)
// ═══════════════════════════════════════════════════════════════════════════
function getEnabledChains() {
  const enabledList = process.env.ENABLED_CHAINS
    ? process.env.ENABLED_CHAINS.split(',').map(s => s.trim().toLowerCase())
    : Object.keys(CHAIN_DEFINITIONS);
  
  const enabled = [];
  
  for (const chainKey of enabledList) {
    const chainDef = CHAIN_DEFINITIONS[chainKey];
    if (!chainDef) {
      console.warn(`[Config] Unknown chain "${chainKey}" in ENABLED_CHAINS, skipping`);
      continue;
    }
    
    const { wsUrl, httpUrl } = getChainRpcUrls(chainKey);
    
    if (!wsUrl || !httpUrl) {
      // Silent skip - only log if explicitly requested via ENABLED_CHAINS
      if (process.env.ENABLED_CHAINS) {
        console.warn(`[Config] ${chainDef.name}: Missing RPC URLs, skipping`);
        console.warn(`  Set ${chainKey.toUpperCase()}_RPC_WS_URL and ${chainKey.toUpperCase()}_RPC_HTTP_URL`);
      }
      continue;
    }
    
    enabled.push({
      key: chainKey,
      ...chainDef,
      wsUrl,
      httpUrl,
    });
  }
  
  return enabled;
}

// State path base (each chain gets its own file)
const STATE_PATH_BASE = (() => {
  const prefer = process.env.STATE_PATH_BASE || '/data';
  return fs.existsSync('/data') ? prefer : (process.env.STATE_PATH_BASE || './data');
})();

export const CONFIG = {
  // ═══════════════════════════════════════════════════════════════════════════
  // NEW: Multi-chain support
  // ═══════════════════════════════════════════════════════════════════════════
  CHAINS: getEnabledChains(),
  CHAIN_DEFINITIONS,
  STATE_PATH_BASE,
  
  // Legacy single-chain config (kept for backwards compatibility)
  // These are used if you want to run single-chain mode
  WS_URL: process.env.RPC_WS_URL || '',
  HTTP_URL: process.env.RPC_HTTP_URL || '',
  CHAIN_NAME: process.env.CHAIN_NAME || 'base',
  EXPLORER_BASE: process.env.EXPLORER_BASE || 'https://basescan.org',
  VAULT: process.env.VAULT_ADDRESS || '',
  REWARD_SWAPPER: process.env.REWARD_SWAPPER_ADDRESS || '0x25f11f947309df89bf4d36da5d9a9fb5f1e186c1',

  // Backfill + confirmations
  BACKFILL_BLOCKS: parseInt(process.env.BACKFILL_BLOCKS || '500', 10),
  CONFIRMATIONS: parseInt(process.env.CONFIRMATIONS || '0', 10),

  // Notifier pacing
  MIN_MS_BETWEEN_MSGS: parseInt(process.env.MIN_MS_BETWEEN_MSGS || '250', 10),

  // Discord/Telegram
  TELEGRAM: {
    TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  },
  DISCORD: {
    WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  },
  
  // Legacy - kept for backwards compat but Base chain def has these now
  POOLS: CHAIN_DEFINITIONS.base.pools,
  STABLECOINS: CHAIN_DEFINITIONS.base.stablecoins,

  // Legacy single state path - now we use per-chain files
  STATE_PATH: (() => {
    const prefer = process.env.STATE_PATH || '/data/event-state.json';
    return fs.existsSync('/data') ? prefer : (process.env.STATE_PATH || './event-state.json');
  })(),
  
  DEDUPE_TTL_MS: parseInt(process.env.DEDUPE_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  NODE_ENV: process.env.NODE_ENV || 'production',
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Helper to get state path for a specific chain
// ═══════════════════════════════════════════════════════════════════════════
export function getStatePath(chainKey) {
  return `${STATE_PATH_BASE}/state-${chainKey}.json`;
}
