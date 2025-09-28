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

