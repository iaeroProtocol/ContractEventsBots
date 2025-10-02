// src/watcher.mjs
import { ethers } from 'ethers';
import { CONFIG } from './config.mjs';
import vaultAbi from './abi/PermalockVault.json' with { type: 'json' };
import poolAbi from './abi/AerodromePool.json' with { type: 'json' };
import { linkTx, linkAddr, prettyArgs, sleep, fmtWei } from './utils.mjs';
import { sendTelegram } from './notify/telegram.mjs';
import { sendDiscord } from './notify/discord.mjs';
import { store } from './store.mjs';

const vaultIface = new ethers.Interface(vaultAbi);
const poolIface = new ethers.Interface(poolAbi);

/* ---------- notifier pacing ---------- */
let lastSentAt = 0;
async function notifyAll(text) {
  const now = Date.now();
  const delta = now - lastSentAt;
  if (delta < CONFIG.MIN_MS_BETWEEN_MSGS) {
    await sleep(CONFIG.MIN_MS_BETWEEN_MSGS - delta);
  }
  await Promise.allSettled([ sendTelegram(text), sendDiscord(text) ]);
  lastSentAt = Date.now();
}

/* ---------- formatting ---------- */
function formatSwapEvent(poolName, argsObj, txHash, address, blockNumber, explorerBase) {
  const { sender, to, amount0In, amount1In, amount0Out, amount1Out } = argsObj;
  
  // Determine trade direction
  let tradeDesc = '';
  if (amount0In > 0n && amount1Out > 0n) {
    tradeDesc = `Bought token1: ${fmtWei(amount1Out)} (sold ${fmtWei(amount0In)} token0)`;
  } else if (amount1In > 0n && amount0Out > 0n) {
    tradeDesc = `Bought token0: ${fmtWei(amount0Out)} (sold ${fmtWei(amount1In)} token1)`;
  }
  
  const header = `**Swap on ${poolName}**\n`;
  const body = `• ${tradeDesc}\n• Sender: ${sender}\n• To: ${to}`;
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Pool: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatVaultEvent(name, argsObj, txHash, address, blockNumber, explorerBase) {
  const header = `**${name}** on *PermalockVault*\n`;
  const body = prettyArgs(argsObj);
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Contract: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatUnknownEvent(topic0, data, txHash, address, blockNumber, explorerBase) {
  const header = `**Unknown event** (topic0: \`${topic0}\`)`;
  const body = `data: \`${(data||'0x').slice(0, 200)}${(data||'').length>200?'…':''}\``;
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Contract: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n\n${body}\n${footer}`;
}

/* ---------- dedupe / confirmations ---------- */
async function shouldProcess(http, log) {
  const key = `${log.transactionHash}:${log.logIndex}`;
  if (store.has(key)) return false;

  if (CONFIG.CONFIRMATIONS > 0) {
    const latest = await http.getBlockNumber();
    if (log.blockNumber > latest - CONFIG.CONFIRMATIONS) return false;
  }

  const wm = store.getWatermark();
  if (log.blockNumber <= wm) return false;

  return true;
}

async function handleLog(http, log, contractType, poolName = null) {
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;
  const key = `${transactionHash}:${log.logIndex}`;

  let text;
  try {
    const iface = contractType === 'pool' ? poolIface : vaultIface;
    const parsed = iface.parseLog({ topics, data });
    const argsObj = {};
    parsed.fragment.inputs.forEach((inp, i) => {
      argsObj[inp.name || `arg${i}`] = parsed.args[i];
    });
    
    if (contractType === 'pool' && parsed.name === 'Swap') {
      text = formatSwapEvent(poolName, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
    } else {
      text = formatVaultEvent(parsed.name, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
    }
  } catch {
    text = formatUnknownEvent(topics?.[0] || '0x', data || '0x', transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
  }

  try {
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    await notifyAll(`${tsLine}${text}`);
    store.markIfNew(key, blockNumber);
  } catch (e) {
    console.error('[Notify error]', e?.message || e);
  }
}

/* ---------- backfill ---------- */
async function backfill(http, addresses, contractTypes, poolNames) {
  let latest = await http.getBlockNumber();
  if (CONFIG.CONFIRMATIONS > 0) latest -= CONFIG.CONFIRMATIONS;

  const fromWatermark = store.getWatermark() + 1;
  const fromBackfill = CONFIG.BACKFILL_BLOCKS > 0 ? Math.max(0, latest - CONFIG.BACKFILL_BLOCKS) : latest;
  const start = Math.max(fromWatermark, fromBackfill);

  if (start >= latest) return;

  console.log(`[Backfill] from ${start} to ${latest}…`);
  
  for (let i = 0; i < addresses.length; i++) {
    const logs = await http.getLogs({ address: addresses[i], fromBlock: start, toBlock: latest });
    for (const log of logs) {
      await handleLog(http, log, contractTypes[i], poolNames[i]);
      await sleep(100);
    }
    console.log(`[Backfill] ${addresses[i]} done (${logs.length} logs)`);
  }

  store.setWatermark(latest);
}

/* ---------- start watcher ---------- */
export async function startWatcher() {
  store.init();

  const vaultAddress = ethers.getAddress(CONFIG.VAULT);
  const poolAddresses = CONFIG.POOLS.map(p => ethers.getAddress(p.address));
  const allAddresses = [vaultAddress, ...poolAddresses];
  const contractTypes = ['vault', ...CONFIG.POOLS.map(() => 'pool')];
  const poolNames = [null, ...CONFIG.POOLS.map(p => p.name)];

  const http = new ethers.JsonRpcProvider(CONFIG.HTTP_URL);

  if (store.getWatermark() === 0 && process.env.SEED_WATERMARK_ON_FIRST_RUN === 'true') {
    const latest = await http.getBlockNumber();
    const seeded = CONFIG.CONFIRMATIONS > 0 ? (latest - CONFIG.CONFIRMATIONS) : latest;
    store.setWatermark(seeded);
    console.log(`[Seed] Watermark set to ${seeded}`);
  }

  await backfill(http, allAddresses, contractTypes, poolNames);

  const ws = new ethers.WebSocketProvider(CONFIG.WS_URL);
  
  // Basic error handler
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));

  // Subscribe to vault
  ws.on({ address: vaultAddress }, async (log) => {
    console.log('[WS] ✓ Vault event:', log.transactionHash);
    try { await handleLog(http, log, 'vault'); }
    catch (e) { console.error('[Handle vault log error]', e?.message || e); }
  });

  // Subscribe to pools
  CONFIG.POOLS.forEach((pool, idx) => {
    ws.on({ address: poolAddresses[idx] }, async (log) => {
      console.log(`[WS] ✓ ${pool.name} event:`, log.transactionHash);
      try { await handleLog(http, log, 'pool', pool.name); }
      catch (e) { console.error(`[Handle ${pool.name} log error]`, e?.message || e); }
    });
    console.log(`[Live] Subscribed to ${pool.name} at ${poolAddresses[idx]}`);
  });

  console.log('[Live] Subscribed to vault at', vaultAddress);
}