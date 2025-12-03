// src/store.mjs
// UPDATED: Changed from singleton to factory function for multi-chain support

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, getStatePath } from './config.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Factory function to create per-chain stores
// ═══════════════════════════════════════════════════════════════════════════
export function createStore(chainKey) {
  const statePath = getStatePath(chainKey);
  const tag = `[Store:${chainKey}]`;
  
  let state = {
    lastProcessedBlock: 0,
    seen: {},
  };

  function load() {
    try {
      if (fs.existsSync(statePath)) {
        const raw = fs.readFileSync(statePath, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') state = { ...state, ...obj };
      }
    } catch (e) {
      console.error(`${tag} load failed:`, e.message);
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    } catch (e) {
      console.error(`${tag} save failed:`, e.message);
    }
  }

  function prune(now = Date.now()) {
    const ttl = CONFIG.DEDUPE_TTL_MS;
    const seen = state.seen || {};
    let removed = 0;
    for (const [k, ts] of Object.entries(seen)) {
      if (!Number.isFinite(ts) || now - ts > ttl) {
        delete seen[k];
        removed++;
      }
    }
    if (removed) {
      state.seen = seen;
    }
  }

  return {
    chainKey,
    statePath,
    
    init() { 
      load(); 
      prune(); 
      save(); 
      console.log(`${tag} Initialized, watermark=${state.lastProcessedBlock}`);
    },
    
    markIfNew(key, blockNumber) {
      const now = Date.now();
      prune(now);
      if (state.seen[key]) return false;
      state.seen[key] = now;
      if (blockNumber > (state.lastProcessedBlock || 0)) {
        state.lastProcessedBlock = blockNumber;
      }
      save();
      return true;
    },
    
    markSeen(key) {
      const now = Date.now();
      prune(now);
      if (state.seen[key]) return false;
      state.seen[key] = now;
      save();
      return true;
    },
    
    has(key) {
      return !!state.seen[key];
    },
    
    getWatermark() {
      return state.lastProcessedBlock || 0;
    },
    
    setWatermark(bn) {
      if (bn > (state.lastProcessedBlock || 0)) {
        state.lastProcessedBlock = bn;
        save();
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY: Keep the old singleton export for backwards compatibility
// This uses the legacy STATE_PATH from config
// ═══════════════════════════════════════════════════════════════════════════
const p = CONFIG.STATE_PATH;
let legacyState = {
  lastProcessedBlock: 0,
  seen: {},
};

function legacyLoad() {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') legacyState = { ...legacyState, ...obj };
    }
  } catch (e) {
    console.error('[Store] load failed:', e.message);
  }
}

function legacySave() {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(legacyState), 'utf8');
  } catch (e) {
    console.error('[Store] save failed:', e.message);
  }
}

function legacyPrune(now = Date.now()) {
  const ttl = CONFIG.DEDUPE_TTL_MS;
  const seen = legacyState.seen || {};
  let removed = 0;
  for (const [k, ts] of Object.entries(seen)) {
    if (!Number.isFinite(ts) || now - ts > ttl) {
      delete seen[k];
      removed++;
    }
  }
  if (removed) {
    legacyState.seen = seen;
  }
}

// Legacy singleton (for backwards compat if watcher.mjs isn't updated)
export const store = {
  init() { legacyLoad(); legacyPrune(); legacySave(); },
  markIfNew(key, blockNumber) {
    const now = Date.now();
    legacyPrune(now);
    if (legacyState.seen[key]) return false;
    legacyState.seen[key] = now;
    if (blockNumber > (legacyState.lastProcessedBlock || 0)) {
      legacyState.lastProcessedBlock = blockNumber;
    }
    legacySave();
    return true;
  },
  markSeen(key) {
    const now = Date.now();
    legacyPrune(now);
    if (legacyState.seen[key]) return false;
    legacyState.seen[key] = now;
    legacySave();
    return true;
  },
  has(key) {
    return !!legacyState.seen[key];
  },
  getWatermark() {
    return legacyState.lastProcessedBlock || 0;
  },
  setWatermark(bn) {
    if (bn > (legacyState.lastProcessedBlock || 0)) {
      legacyState.lastProcessedBlock = bn;
      legacySave();
    }
  }
};
