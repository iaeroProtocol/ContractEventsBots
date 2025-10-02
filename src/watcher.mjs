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

// ---- manual Swap (UniswapV2/Solidly-style) fallback ----
// event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)
const SWAP_V2_TOPIC = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const coder = ethers.AbiCoder.defaultAbiCoder();
function tryParseV2Swap(log) {
  try {
    if (!log?.topics?.length) return null;
    if (log.topics[0] !== SWAP_V2_TOPIC) return null;
    // topics[1] = sender, topics[2] = to (both indexed)
    const sender = ethers.getAddress(ethers.dataSlice(log.topics[1], 12)); // last 20 bytes
    const to     = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
    // data encodes 4 uint256
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return {
      name: 'Swap',
      argsObj: { sender, to, amount0In, amount1In, amount0Out, amount1Out }
    };
  } catch {
    return null;
  }
}

/* ---------- notifier pacing ---------- */
let lastSentAt = 0;
async function notifyAll(text) {
  const now = Date.now();
  const delta = now - lastSentAt;
  if (delta < CONFIG.MIN_MS_BETWEEN_MSGS) {
    await sleep(CONFIG.MIN_MS_BETWEEN_MSGS - delta);
  }
  await Promise.allSettled([sendTelegram(text), sendDiscord(text)]);
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
      console.log(
        `[Skip] awaiting confirmations (${CONFIG.CONFIRMATIONS}) for ${log.transactionHash} @${log.blockNumber} (latest=${latest})`
      );
      return false;
    }
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
    let parsed, argsObj;

    if (contractType === 'pool') {
      // First try the provided ABI
      try {
        parsed = poolIface.parseLog({ topics, data });
      } catch {
        parsed = null;
      }

      // Fallback to UniswapV2/Solidly-style Swap if ABI didn't match
      if (!parsed) {
        const v2 = tryParseV2Swap(log);
        if (v2) {
          parsed = { name: v2.name };
          argsObj = v2.argsObj;
        }
      }
    } else {
      parsed = vaultIface.parseLog({ topics, data });
    }

    if (!parsed) {
      console.log(`[Parse] unknown event at ${address} tx=${transactionHash}`);
      store.markIfNew(key, blockNumber);
      return;
    }

    if (!argsObj) {
      // Build argsObj from parsed fragment if we used the ABI path
      argsObj = {};
      parsed.fragment.inputs.forEach((inp, i) => {
        argsObj[inp.name || `arg${i}`] = parsed.args[i];
      });
    }

    if (contractType === 'pool' && parsed.name === 'Swap') {
      text = formatSwapEvent(poolName, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
    } else if (contractType === 'vault') {
      text = formatVaultEvent(parsed.name, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
    } else {
      // Not a Swap (pool) or a vault event => ignore but watermark
      store.markIfNew(key, blockNumber);
      return;
    }
  } catch (e) {
    console.log(`[ParseError] ${contractType} ${poolName ?? ''} tx=${transactionHash} ${e?.message || e}`);
    store.markIfNew(key, blockNumber);
    return;
  }

  try {
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    const msg = `${tsLine}${text}`;
    console.log('[Notify] ', msg.replace(/\n/g, ' | '));
    await notifyAll(msg);
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
  const fromBackfill  = CONFIG.BACKFILL_BLOCKS > 0 ? Math.max(0, latest - CONFIG.BACKFILL_BLOCKS) : latest;
  const start         = Math.max(fromWatermark, fromBackfill);

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

  // Wait for connection to establish
  await ws.ready;
  console.log('[WS] ✅ Connection established');

  // Basic error handler
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));

  // Health check every minute
  setInterval(async () => {
    try {
      const block = await ws.getBlockNumber();
      console.log('[WS] Health check - current block:', block);
    } catch (e) {
      console.error('[WS] Health check failed:', e?.message || e);
    }
  }, 60000);

  // Subscribe to vault
  ws.on({ address: vaultAddress }, async (log) => {
    console.log('[WS] ✓ Vault event:', log.transactionHash, 'Block:', log.blockNumber);
    try {
      if (CONFIG.CONFIRMATIONS > 0) {
        try { await http.waitForTransaction(log.transactionHash, CONFIG.CONFIRMATIONS); }
        catch (e) { console.log('[ConfirmWait vault] error or timeout:', e?.message || e); }
      }
      await handleLog(http, log, 'vault');
    } catch (e) {
      console.error('[Handle vault log error]', e?.message || e);
    }
  });

  // Subscribe to pools
  CONFIG.POOLS.forEach((pool, idx) => {
    ws.on({ address: poolAddresses[idx] }, async (log) => {
      console.log(`[WS] ✓ ${pool.name} event:`, log.transactionHash, 'Block:', log.blockNumber);
      try {
        if (CONFIG.CONFIRMATIONS > 0) {
          try { await http.waitForTransaction(log.transactionHash, CONFIG.CONFIRMATIONS); }
          catch (e) { console.log(`[ConfirmWait ${pool.name}] error or timeout:`, e?.message || e); }
        }
        await handleLog(http, log, 'pool', pool.name);
      } catch (e) {
        console.error(`[Handle ${pool.name} log error]`, e?.message || e);
      }
    });
    console.log(`[Live] Subscribed to ${pool.name} at ${poolAddresses[idx]}`);
  });

  console.log('[Live] Subscribed to vault at', vaultAddress);
}
