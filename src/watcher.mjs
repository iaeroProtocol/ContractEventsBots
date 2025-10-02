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
const poolIface  = new ethers.Interface(poolAbi);

/* ---------------- Swap signature support ---------------- */
// V2 classic: Swap(address indexed sender, uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out, address indexed to)
const TOPIC_V2_CLASSIC = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
// V2 alt:    Swap(address indexed sender, address indexed to, uint256 a0In, uint256 a1In, uint256 a0Out, uint256 a1Out)
const TOPIC_V2_ALT     = ethers.id('Swap(address,address,uint256,uint256,uint256,uint256)');
// V3:        Swap(address indexed sender, address indexed recipient, int256 a0, int256 a1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
const TOPIC_V3         = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');

const coder = ethers.AbiCoder.defaultAbiCoder();
const addrFromTopic = (t) => ethers.getAddress(ethers.dataSlice(t, 12));

function decodeSwapFromTopicsAndData(log) {
  const t0 = log?.topics?.[0];
  if (!t0) return null;

  // V2-alt (your Base scan example)
  if (t0 === TOPIC_V2_ALT) {
    const sender = addrFromTopic(log.topics[1]);
    const to     = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { sender, to, amount0In, amount1In, amount0Out, amount1Out };
  }

  // V2 classic
  if (t0 === TOPIC_V2_CLASSIC) {
    const sender = addrFromTopic(log.topics[1]);
    const to     = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { sender, to, amount0In, amount1In, amount0Out, amount1Out };
  }

  // V3 / CLAMM
  if (t0 === TOPIC_V3) {
    const sender    = addrFromTopic(log.topics[1]);
    const recipient = addrFromTopic(log.topics[2]);
    const [amount0, amount1/*, sqrtPriceX96, liquidity, tick*/] =
      coder.decode(['int256','int256','uint160','uint128','int24'], log.data);
    const a0 = BigInt(amount0);
    const a1 = BigInt(amount1);
    const amount0In  = a0 > 0n ? a0 : 0n;
    const amount0Out = a0 < 0n ? -a0 : 0n;
    const amount1In  = a1 > 0n ? a1 : 0n;
    const amount1Out = a1 < 0n ? -a1 : 0n;
    return { sender, to: recipient, amount0In, amount1In, amount0Out, amount1Out };
  }

  return null; // not a supported Swap
}

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

  let tradeDesc = '';
  if (amount0In > 0n && amount1Out > 0n) {
    tradeDesc = `Bought token1: ${fmtWei(amount1Out)} (sold ${fmtWei(amount0In)} token0)`;
  } else if (amount1In > 0n && amount0Out > 0n) {
    tradeDesc = `Bought token0: ${fmtWei(amount0Out)} (sold ${fmtWei(amount1In)} token1)`;
  } else {
    tradeDesc = `Swap executed (amount0In=${fmtWei(amount0In)}, amount1In=${fmtWei(amount1In)}, amount0Out=${fmtWei(amount0Out)}, amount1Out=${fmtWei(amount1Out)})`;
  }

  const header = `**Swap on ${poolName}**\n`;
  const body   = `• ${tradeDesc}\n• Sender: ${sender}\n• To: ${to}`;
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Pool: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatVaultEvent(name, argsObj, txHash, address, blockNumber, explorerBase) {
  const header = `**${name}** on *PermalockVault*\n`;
  const body   = prettyArgs(argsObj);
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Contract: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

/* ---------- dedupe / confirmations ---------- */
async function shouldProcess(http, log) {
  const key = `${log.transactionHash}:${log.logIndex}`;
  if (store.has(key)) return false;

  if (CONFIG.CONFIRMATIONS > 0) {
    const latest = await http.getBlockNumber();
    if (log.blockNumber > latest - CONFIG.CONFIRMATIONS) {
      return false; // ignore until confirmed; WS handler waits anyway
    }
  }

  const wm = store.getWatermark();
  if (log.blockNumber <= wm) return false;

  return true;
}

/* ---------- core handlers ---------- */
function buildArgsObjFromAbiParsed(parsed) {
  const argsObj = {};
  parsed.fragment.inputs.forEach((inp, i) => {
    argsObj[inp.name || `arg${i}`] = parsed.args[i];
  });
  return argsObj;
}

async function handlePoolLog(http, log, poolName) {
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;
  const key = `${transactionHash}:${log.logIndex}`;

  // 1) Try ABI path first
  let argsObj = null;
  try {
    const parsed = poolIface.parseLog({ topics, data });
    if (parsed?.name === 'Swap') {
      argsObj = buildArgsObjFromAbiParsed(parsed);
    }
  } catch { /* no-op */ }

  // 2) Fallback signature decoders
  if (!argsObj) {
    argsObj = decodeSwapFromTopicsAndData(log);
  }

  // If still no match, ignore silently (as requested)
  if (!argsObj) {
    store.markIfNew(key, blockNumber);
    return;
  }

  // Notify
  try {
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    const msg = `${tsLine}${formatSwapEvent(poolName, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE)}`;
    await notifyAll(msg);
    store.markIfNew(key, blockNumber);
  } catch (e) {
    console.error('[Notify error]', e?.message || e);
  }
}

async function handleVaultLog(http, log) {
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;
  const key = `${transactionHash}:${log.logIndex}`;

  try {
    const parsed = vaultIface.parseLog({ topics, data });
    const argsObj = buildArgsObjFromAbiParsed(parsed);
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    const msg = `${tsLine}${formatVaultEvent(parsed.name, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE)}`;
    await notifyAll(msg);
    store.markIfNew(key, blockNumber);
  } catch {
    // Not a recognized vault event; just watermark and move on.
    store.markIfNew(key, blockNumber);
  }
}

/* ---------- backfill ---------- */
async function backfill(http, addresses, contractTypes, poolNames) {
  let latest = await http.getBlockNumber();
  if (CONFIG.CONFIRMATIONS > 0) latest -= CONFIG.CONFIRMATIONS;

  const fromWatermark = store.getWatermark() + 1;
  const fromBackfill  = CONFIG.BACKFILL_BLOCKS > 0 ? Math.max(0, latest - CONFIG.BACKFILL_BLOCKS) : latest;
  const start         = Math.max(fromWatermark, fromBackfill);
  if (start >= latest) return;

  console.log(`[Backfill] from ${start} to ${latest}…`);
  for (let i = 0; i < addresses.length; i++) {
    const logs = await http.getLogs({ address: addresses[i], fromBlock: start, toBlock: latest });
    for (const log of logs) {
      if (contractTypes[i] === 'pool') await handlePoolLog(http, log, poolNames[i]);
      else await handleVaultLog(http, log);
      await sleep(100);
    }
    console.log(`[Backfill] ${addresses[i]} done (${logs.length} logs)`);
  }
  store.setWatermark(latest);
}

/* ---------- start watcher ---------- */
export async function startWatcher() {
  store.init();

  const vaultAddress  = ethers.getAddress(CONFIG.VAULT);
  const poolAddresses = CONFIG.POOLS.map(p => ethers.getAddress(p.address));
  const allAddresses  = [vaultAddress, ...poolAddresses];
  const contractTypes = ['vault', ...CONFIG.POOLS.map(() => 'pool')];
  const poolNames     = [null, ...CONFIG.POOLS.map(p => p.name)];

  const http = new ethers.JsonRpcProvider(CONFIG.HTTP_URL);

  if (store.getWatermark() === 0 && process.env.SEED_WATERMARK_ON_FIRST_RUN === 'true') {
    const latest = await http.getBlockNumber();
    const seeded = CONFIG.CONFIRMATIONS > 0 ? (latest - CONFIG.CONFIRMATIONS) : latest;
    store.setWatermark(seeded);
    console.log(`[Seed] Watermark set to ${seeded}`);
  }

  await backfill(http, allAddresses, contractTypes, poolNames);

  const ws = new ethers.WebSocketProvider(CONFIG.WS_URL);
  await ws.ready;
  console.log('[WS] ✅ Connection established');

  ws.on('error', (e) => console.error('[WS error]', e?.message || e));

  // Health ping
  setInterval(async () => {
    try { console.log('[WS] Health check - current block:', await ws.getBlockNumber()); }
    catch (e) { console.error('[WS] Health check failed:', e?.message || e); }
  }, 60000);

  // Vault
  ws.on({ address: vaultAddress }, async (log) => {
    try {
      if (CONFIG.CONFIRMATIONS > 0) {
        try { await http.waitForTransaction(log.transactionHash, CONFIG.CONFIRMATIONS); } catch {}
      }
      await handleVaultLog(http, log);
    } catch (e) { console.error('[Handle vault log error]', e?.message || e); }
  });

  // Pools
  CONFIG.POOLS.forEach((pool, idx) => {
    ws.on({ address: poolAddresses[idx] }, async (log) => {
      try {
        if (CONFIG.CONFIRMATIONS > 0) {
          try { await http.waitForTransaction(log.transactionHash, CONFIG.CONFIRMATIONS); } catch {}
        }
        await handlePoolLog(http, log, pool.name);
      } catch (e) { console.error(`[Handle ${pool.name} log error]`, e?.message || e); }
    });
    console.log(`[Live] Subscribed to ${pool.name} at ${poolAddresses[idx]}`);
  });

  console.log('[Live] Subscribed to vault at', vaultAddress);
}
