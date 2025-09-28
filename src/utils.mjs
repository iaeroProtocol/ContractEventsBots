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

