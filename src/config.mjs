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

export const CONFIG = {
  WS_URL: req('RPC_WS_URL'),
  HTTP_URL: req('RPC_HTTP_URL'),
  CHAIN_NAME: process.env.CHAIN_NAME || 'base',
  EXPLORER_BASE: process.env.EXPLORER_BASE || 'https://basescan.org',
  VAULT: req('VAULT_ADDRESS'),
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
  
  POOLS: [
    { address: '0x08d49DA370ecfFBC4c6Fdd2aE82B2D6aE238Affd', name: 'iAERO/AERO' },
    { address: '0x8966379fCD16F7cB6c6EA61077B6c4fAfECa28f4', name: 'LIQ/USDC' }
  ],

  STABLECOINS: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
  },

  // Dedupe storage
  // Use a Railway volume mount at /data if available; else local file
  STATE_PATH: (() => {
    const prefer = process.env.STATE_PATH || '/data/event-state.json';
    // fallback if /data doesn't exist
    return fs.existsSync('/data') ? prefer : (process.env.STATE_PATH || './event-state.json');
  })(),
  // prune seen keys older than this (ms)
  DEDUPE_TTL_MS: parseInt(process.env.DEDUPE_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  NODE_ENV: process.env.NODE_ENV || 'production',
};

