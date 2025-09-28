import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

const p = CONFIG.STATE_PATH;
let state = {
  lastProcessedBlock: 0,
  // key -> timestamp
  seen: {},
};

function load() {
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') state = { ...state, ...obj };
    }
  } catch (e) {
    console.error('[Store] load failed:', e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('[Store] save failed:', e.message);
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
    // keep lastProcessedBlock
    state.seen = seen;
  }
}

export const store = {
  init() { load(); prune(); save(); },
  // true if first time, false if duplicate
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

