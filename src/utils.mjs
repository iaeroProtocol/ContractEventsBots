import { ethers } from 'ethers';

/** Shorten addresses/tx */
export function short(addr, n = 4) {
  if (!addr) return '';
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

export function fmtWei(v) {
  try { return ethers.formatEther(v); } catch { return String(v); }
}

export function linkTx(explorerBase, txHash) {
  return `${explorerBase}/tx/${txHash}`;
}

export function linkAddr(explorerBase, addr) {
  return `${explorerBase}/address/${addr}`;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Pretty print event args object */
export function prettyArgs(args) {
  const out = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'bigint') {
      out.push(`• ${k}: ${fmtWei(v)} (${v})`);
    } else {
      out.push(`• ${k}: ${v}`);
    }
  }
  return out.join('\n');
}

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

// In-memory cache: address (lowercase) -> { symbol, decimals }
const tokenCache = new Map();

/**
 * Fetch symbol and decimals for a token address.
 * Results are cached in memory.
 */
export async function getTokenInfo(provider, address) {
  const addrLower = address.toLowerCase();
  
  if (tokenCache.has(addrLower)) {
    return tokenCache.get(addrLower);
  }

  let symbol = short(address);
  let decimals = 18;

  try {
    const contract = new ethers.Contract(address, ERC20_ABI, provider);
    const [sym, dec] = await Promise.all([
      contract.symbol().catch(() => null),
      contract.decimals().catch(() => 18),
    ]);
    if (sym) symbol = sym;
    if (dec !== null && dec !== undefined) decimals = Number(dec);
  } catch (e) {
    console.warn(`[TokenInfo] Failed to fetch for ${address}:`, e?.message || e);
  }

  const info = { symbol, decimals };
  tokenCache.set(addrLower, info);
  return info;
}

/**
 * Batch fetch token info for multiple addresses.
 * Returns Map<addressLower, { symbol, decimals }>
 */
export async function getTokenInfoBatch(provider, addresses) {
  const results = new Map();
  const toFetch = [];

  for (const addr of addresses) {
    const addrLower = addr.toLowerCase();
    if (tokenCache.has(addrLower)) {
      results.set(addrLower, tokenCache.get(addrLower));
    } else {
      toFetch.push(addr);
    }
  }

  // Fetch missing ones in parallel (with some concurrency limit)
  const BATCH_SIZE = 10;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const infos = await Promise.all(batch.map(addr => getTokenInfo(provider, addr)));
    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j].toLowerCase(), infos[j]);
    }
  }

  return results;
}

/* ---------- Price Fetching (DefiLlama) ---------- */

const LLAMA_URL = 'https://coins.llama.fi/prices/current/';
const priceCache = new Map(); // key -> { price, fetchedAt }
const PRICE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch USD prices for tokens from DefiLlama.
 * @param {string[]} addresses - Token addresses
 * @param {string} chain - Chain slug (default: 'base')
 * @returns {Map<addressLower, number>} - Price in USD (0 if not found)
 */
export async function fetchPrices(addresses, chain = 'base') {
  const now = Date.now();
  const results = new Map();
  const toFetch = [];

  // Check cache first
  for (const addr of addresses) {
    const key = `${chain}:${addr.toLowerCase()}`;
    const cached = priceCache.get(key);
    if (cached && (now - cached.fetchedAt) < PRICE_TTL_MS) {
      results.set(addr.toLowerCase(), cached.price);
    } else {
      toFetch.push(addr.toLowerCase());
    }
  }

  if (toFetch.length === 0) {
    return results;
  }

  // Build DefiLlama request
  const keys = toFetch.map(a => `${chain}:${a}`).join(',');
  const url = `${LLAMA_URL}${keys}`;

  try {
    const res = await fetch(url, { 
      signal: AbortSignal.timeout(10000),
      headers: { 'Accept': 'application/json' }
    });
    
    if (!res.ok) {
      console.warn(`[Price] DefiLlama HTTP ${res.status}`);
      for (const addr of toFetch) {
        results.set(addr, 0);
      }
      return results;
    }

    const data = await res.json();
    const coins = data?.coins || {};

    for (const addr of toFetch) {
      const key = `${chain}:${addr}`;
      const price = coins[key]?.price ?? 0;
      results.set(addr, price);
      priceCache.set(key, { price, fetchedAt: now });
    }
  } catch (e) {
    console.warn(`[Price] DefiLlama fetch error:`, e?.message || e);
    for (const addr of toFetch) {
      results.set(addr, 0);
    }
  }

  return results;
}

/**
 * Format a number with commas and fixed decimals
 */
export function fmtNumber(n, decimals = 2) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { 
    minimumFractionDigits: decimals, 
    maximumFractionDigits: decimals 
  });
}

/**
 * Format USD amount
 */
export function fmtUsd(n) {
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + fmtNumber(n, 2);
}
