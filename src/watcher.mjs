// src/watcher.mjs
import { ethers } from 'ethers';
import { CONFIG } from './config.mjs';
import vaultAbi from './abi/PermalockVault.json' with { type: 'json' };
import poolAbi from './abi/AerodromePool.json' with { type: 'json' };
import swapperAbi from './abi/RewardSwapper.json' with { type: 'json' };
import { linkTx, linkAddr, prettyArgs, sleep, fmtWei, short, getTokenInfoBatch, fetchPrices, fmtUsd, fmtNumber } from './utils.mjs';
import { sendTelegram } from './notify/telegram.mjs';
import { sendDiscord } from './notify/discord.mjs';
import { store } from './store.mjs';

/* ---------- ABIs / interfaces ---------- */
const vaultIface = new ethers.Interface(vaultAbi);
const poolIface  = new ethers.Interface(poolAbi);
const swapperIface = new ethers.Interface(swapperAbi);
const poolConfigByAddr = new Map(
  CONFIG.POOLS.map(p => [ethers.getAddress(p.address).toLowerCase(), p])
);

/* ---------------- Swap signature support ---------------- */
const TOPIC_V2_CLASSIC = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const TOPIC_V2_ALT     = ethers.id('Swap(address,address,uint256,uint256,uint256,uint256)');
const TOPIC_V3         = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
// RewardSwapper event topics
const TOPIC_PLAN_EXECUTED = ethers.id('PlanExecuted(address,address,uint256,uint256)');
const TOPIC_SWAP_EXECUTED = ethers.id('SwapExecuted(uint8,address,address,uint256,uint256)');

const coder = ethers.AbiCoder.defaultAbiCoder();
const addrFromTopic = (t) => ethers.getAddress(ethers.dataSlice(t, 12));

function decodeSwapFromTopicsAndData(log) {
  const t0 = log?.topics?.[0];
  if (!t0) return null;

  // V2-alt
  if (t0 === TOPIC_V2_ALT) {
    const sender = addrFromTopic(log.topics[1]);
    const to     = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { kind: 'v2-alt', sender, to, amount0In, amount1In, amount0Out, amount1Out };
  }

  // V2 classic
  if (t0 === TOPIC_V2_CLASSIC) {
    const sender = addrFromTopic(log.topics[1]);
    const to     = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { kind: 'v2-classic', sender, to, amount0In, amount1In, amount0Out, amount1Out };
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
    return { kind: 'v3', sender, to: recipient, amount0In, amount1In, amount0Out, amount1Out };
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
function formatSwapEvent(poolConfig, argsObj, txHash, address, blockNumber, explorerBase) {
  const { sender, to, amount0In, amount1In, amount0Out, amount1Out } = argsObj;
  
  const t0 = poolConfig?.token0 || { symbol: 'token0', decimals: 18 };
  const t1 = poolConfig?.token1 || { symbol: 'token1', decimals: 18 };
  const poolName = poolConfig?.name || 'Unknown Pool';
  
  // Format amounts with proper decimals
  const fmt = (amt, token) => fmtNumber(Number(ethers.formatUnits(amt, token.decimals)), 4);
  
  let tradeDesc = '';
  if (amount0In > 0n && amount1Out > 0n) {
    tradeDesc = `Bought ${fmt(amount1Out, t1)} ${t1.symbol} (sold ${fmt(amount0In, t0)} ${t0.symbol})`;
  } else if (amount1In > 0n && amount0Out > 0n) {
    tradeDesc = `Bought ${fmt(amount0Out, t0)} ${t0.symbol} (sold ${fmt(amount1In, t1)} ${t1.symbol})`;
  } else {
    // Fallback: show all amounts (rare edge case)
    tradeDesc = `Swap: ${fmt(amount0In, t0)} ${t0.symbol} in, ${fmt(amount1In, t1)} ${t1.symbol} in → ${fmt(amount0Out, t0)} ${t0.symbol} out, ${fmt(amount1Out, t1)} ${t1.symbol} out`;
  }
  
  const header = `🔄 **Swap on ${poolName}**\n`;
  const body   = `• ${tradeDesc}\n• Sender: \`${short(sender)}\`\n• To: \`${short(to)}\``;
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Pool: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatVaultEvent(name, argsObj, txHash, address, blockNumber, explorerBase) {
  const header = `**${name}** on *PermalockVault*\n`;
  const body   = prettyArgs(argsObj);
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Contract: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

const ROUTER_NAMES = {
  0: 'Aerodrome',
  1: 'UniV3',
  2: 'Aggregator',
};

/**
 * Format PlanExecuted with enriched swap details
 */
function formatPlanExecutedEvent({ caller, recipient, steps, totalOutAmt, swaps, totalUsd, blockNumber, txHash, timestamp, explorerBase }) {
  const header = `🔄 **RewardSwapper Plan Executed**\n`;
  
  let body = '';
  body += `• Steps: ${steps}\n`;
  body += `• Recipient: \`${short(recipient)}\`\n`;
  
  // Group swaps by output token for cleaner display
  if (swaps && swaps.length > 0) {
    body += `\n**Swaps:**\n`;
    for (const s of swaps) {
      const routerName = ROUTER_NAMES[s.kind] || `Router(${s.kind})`;
      body += `  └ ${s.inSymbol} → ${s.outSymbol} via ${routerName}\n`;
      body += `     ${fmtNumber(s.inHuman, 4)} → ${fmtNumber(s.outHuman, 4)}`;
      if (s.outUsd > 0) {
        body += ` (${fmtUsd(s.outUsd)})`;
      }
      body += `\n`;
    }
  }
  
  // Total USD
  if (totalUsd > 0) {
    body += `\n💰 **Total Value: ${fmtUsd(totalUsd)}**\n`;
  }
  
  const tsLine = timestamp ? `🕐 ${new Date(timestamp * 1000).toISOString()}\n` : '';
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🧱 Block: ${blockNumber}`;
  
  return `${tsLine}${header}\n${body}${footer}`;
}

/* ---------- dedupe / confirmations ---------- */
const keyOf = (log) => `${log.transactionHash}:${log.logIndex}`;

// Shared WS state (used for resilient confirmations + watchdog)
let ws;                         // ethers.WebSocketProvider
let latestWsBlock = 0;          // last ws block number seen
let lastWsBlockAt = Date.now(); // timestamp of last block tick
let lastAnyLogAt  = Date.now(); // timestamp of last contract log
let reconnecting  = false;      // re-entrancy guard
let reconnectTimer = null;      // debounce immediate reconnect
let reconnectBackoffMs = 1000;  // 1s → capped backoff

const WS_IDLE_MS         = CONFIG.WS_IDLE_MS ?? 10 * 60_000; // 10 minutes
const SWEEP_INTERVAL_MS  = CONFIG.SWEEP_INTERVAL_MS ?? 15_000; // 15s (set to 0 to disable)
const WS_BLOCK_STALL_MS  = CONFIG.WS_BLOCK_STALL_MS ?? 180_000; // 3 minutes

async function latestBlockSafe(http) {
  // Take the freshest of HTTP and WS; tolerate either side failing
  const results = await Promise.allSettled([
    http.getBlockNumber(),
    ws?.getBlockNumber?.()
  ]);
  let best = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && Number.isFinite(Number(r.value))) {
      best = Math.max(best, Number(r.value));
    }
  }
  return best;
}

async function hasEnoughConf(http, log) {
  if (CONFIG.CONFIRMATIONS <= 0) return true;
  const latest = await latestBlockSafe(http);
  return log.blockNumber <= (latest - CONFIG.CONFIRMATIONS);
}

async function shouldProcess(http, log) {
  // NOTE: allow multiple logs in the *same block* (no <=)
  if (store.has(keyOf(log))) return false;
  const wm = store.getWatermark();
  if (log.blockNumber < wm) return false; // <-- changed from <= to <
  return true;
}

/* ---------- pending queue for confirmations ---------- */
const pending = new Map(); // key -> { log, contractType, poolName }

function enqueuePending(log, contractType, poolName) {
  const k = keyOf(log);
  if (!pending.has(k)) pending.set(k, { log, contractType, poolName });
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
  const k = keyOf(log);

  if (!(await hasEnoughConf(http, log))) {
    enqueuePending(log, 'pool', poolName);
    return;
  }
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;

  // 1) Try ABI
  let argsObj = null;
  try {
    const parsed = poolIface.parseLog({ topics, data });
    if (parsed?.name === 'Swap') {
      argsObj = buildArgsObjFromAbiParsed(parsed);
      console.log(`[Decode] ABI Swap matched (${poolName}) tx=${transactionHash}`);
    }
  } catch { /* fall through */ }

  // 2) Fallbacks
  if (!argsObj) {
    const dec = decodeSwapFromTopicsAndData(log);
    if (dec) {
      argsObj = dec;
      console.log(`[Decode] Fallback ${dec.kind} Swap matched (${poolName}) tx=${transactionHash}`);
    }
  }

  // Not a supported Swap → ignore (do NOT advance watermark)
  if (!argsObj) return;

  try {
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    const poolConfig = poolConfigByAddr.get(address.toLowerCase());
    const msg = `${tsLine}${formatSwapEvent(poolConfig, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE)}`;
    console.log('[Notify Swap]', msg.replace(/\n/g, ' | '));
    await notifyAll(msg);
    // Only after successful notify, mark + advance watermark
    store.markIfNew(k, blockNumber);
  } catch (e) {
    console.error('[Notify error]', e?.message || e);
  }
}

async function handleVaultLog(http, log) {
  const k = keyOf(log);

  if (!(await hasEnoughConf(http, log))) {
    enqueuePending(log, 'vault', null);
    return;
  }
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;

  try {
    const parsed = vaultIface.parseLog({ topics, data });
    const argsObj = buildArgsObjFromAbiParsed(parsed);
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    const msg = `${tsLine}${formatVaultEvent(parsed.name, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE)}`;
    console.log('[Notify Vault]', parsed.name, transactionHash);
    await notifyAll(msg);
    store.markIfNew(k, blockNumber);
  } catch {
    // Unknown vault event → ignore without advancing watermark
    return;
  }
}

/**
 * Handle RewardSwapper PlanExecuted event
 * Fetches tx receipt to get SwapExecuted details, resolves symbols, fetches prices
 */
async function handleSwapperLog(http, log) {
  const k = keyOf(log);

  if (!(await hasEnoughConf(http, log))) {
    enqueuePending(log, 'swapper', null);
    return;
  }
  
  // Only check dedupe, not watermark (watermark can cause issues during backfill)
  if (store.has(k)) return;

  const { transactionHash, blockNumber, topics, data, address } = log;

  // Only process PlanExecuted events
  if (topics[0] !== TOPIC_PLAN_EXECUTED) {
    return;
  }

  try {
    // Parse PlanExecuted
    const parsed = swapperIface.parseLog({ topics, data });
    if (parsed?.name !== 'PlanExecuted') return;

    const caller = parsed.args[0];
    const recipient = parsed.args[1];
    const steps = Number(parsed.args[2]);
    const totalOutAmt = parsed.args[3];

    console.log(`[Swapper] PlanExecuted tx=${transactionHash} steps=${steps}`);

    // Fetch tx receipt to get all SwapExecuted events
    const receipt = await http.getTransactionReceipt(transactionHash);
    const swapperAddr = address.toLowerCase();
    
    // Parse SwapExecuted events from the same contract in this tx
    const swapEvents = [];
    const allTokens = new Set();

    for (const rLog of receipt.logs) {
      if (rLog.address.toLowerCase() !== swapperAddr) continue;
      if (rLog.topics[0] !== TOPIC_SWAP_EXECUTED) continue;

      try {
        const swapParsed = swapperIface.parseLog({ topics: rLog.topics, data: rLog.data });
        if (swapParsed?.name === 'SwapExecuted') {
          const kind = Number(swapParsed.args[0]);
          const tokenIn = swapParsed.args[1];
          const outToken = swapParsed.args[2];
          const inAmt = swapParsed.args[3];
          const outAmt = swapParsed.args[4];
          
          swapEvents.push({ kind, tokenIn, outToken, inAmt, outAmt });
          allTokens.add(tokenIn.toLowerCase());
          allTokens.add(outToken.toLowerCase());
        }
      } catch { /* skip unparseable */ }
    }

    // Resolve token symbols and decimals
    const tokenInfoMap = await getTokenInfoBatch(http, Array.from(allTokens));
    
    // Fetch prices for output tokens
    const outTokens = [...new Set(swapEvents.map(s => s.outToken.toLowerCase()))];
    const priceMap = await fetchPrices(outTokens, 'base');

    // Build enriched swap list with USD values
    let totalUsd = 0;
    const enrichedSwaps = [];

    for (const s of swapEvents) {
      const inInfo = tokenInfoMap.get(s.tokenIn.toLowerCase()) || { symbol: short(s.tokenIn), decimals: 18 };
      const outInfo = tokenInfoMap.get(s.outToken.toLowerCase()) || { symbol: short(s.outToken), decimals: 18 };
      
      const inHuman = Number(ethers.formatUnits(s.inAmt, inInfo.decimals));
      const outHuman = Number(ethers.formatUnits(s.outAmt, outInfo.decimals));
      
      // Check if output is a known stablecoin (assume $1)
      const stableInfo = CONFIG.STABLECOINS[s.outToken.toLowerCase()];
      let outPrice = 0;
      if (stableInfo) {
        outPrice = 1.0;
      } else {
        outPrice = priceMap.get(s.outToken.toLowerCase()) || 0;
      }
      
      const outUsd = outHuman * outPrice;
      totalUsd += outUsd;

      enrichedSwaps.push({
        kind: s.kind,
        tokenIn: s.tokenIn,
        outToken: s.outToken,
        inSymbol: inInfo.symbol,
        outSymbol: outInfo.symbol,
        inAmt: s.inAmt,
        outAmt: s.outAmt,
        inHuman,
        outHuman,
        outUsd,
      });
    }

    // Get block timestamp
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const timestamp = blk?.timestamp || null;

    // Format and send notification
    const msg = formatPlanExecutedEvent({
      caller,
      recipient,
      steps,
      totalOutAmt,
      swaps: enrichedSwaps,
      totalUsd,
      blockNumber,
      txHash: transactionHash,
      timestamp,
      explorerBase: CONFIG.EXPLORER_BASE,
    });

    console.log('[Notify Swapper]', msg.replace(/\n/g, ' | '));
    await notifyAll(msg);
    store.markIfNew(k, blockNumber);

  } catch (e) {
    console.error('[Swapper] Error handling PlanExecuted:', e?.message || e);
  }
}

/* ---------- backfill (startup only) ---------- */
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
      else if (contractTypes[i] === 'swapper') await handleSwapperLog(http, log);
      else await handleVaultLog(http, log);
      await sleep(50);
    }
    console.log(`[Backfill] ${addresses[i]} done (${logs.length} logs)`);
  }
  // Safe because we restricted to (latest - confirmations)
  store.setWatermark(latest);
}

/* ---------- sweep backstop (periodic) ---------- */
async function sweepRange(http, fromBlock, toBlock, addresses, contractTypes, poolNames) {
  let total = 0;
  for (let i = 0; i < addresses.length; i++) {
    const logs = await http.getLogs({ address: addresses[i], fromBlock, toBlock });
    total += logs.length;
    for (const log of logs) {
      if (contractTypes[i] === 'pool') await handlePoolLog(http, log, poolNames[i]);
      else if (contractTypes[i] === 'swapper') await handleSwapperLog(http, log);
      else await handleVaultLog(http, log);
      await sleep(20);
    }
  }
  // If truly no logs, it's safe to advance watermark to reduce rescans
  if (total === 0) store.setWatermark(toBlock);
}

/* ---------- start watcher ---------- */
export async function startWatcher() {
  store.init();

  const vaultAddress   = ethers.getAddress(CONFIG.VAULT);
  const swapperAddress = ethers.getAddress(CONFIG.REWARD_SWAPPER);
  const poolAddresses  = CONFIG.POOLS.map(p => ethers.getAddress(p.address));
  
  // All addresses to monitor
  const allAddresses  = [vaultAddress, swapperAddress, ...poolAddresses];
  const contractTypes = ['vault', 'swapper', ...CONFIG.POOLS.map(() => 'pool')];
  const poolNames     = [null, null, ...CONFIG.POOLS.map(p => p.name)];

  console.log(`[Config] Monitoring:`);
  console.log(`  Vault:    ${vaultAddress}`);
  console.log(`  Swapper:  ${swapperAddress}`);
  for (const p of CONFIG.POOLS) {
    console.log(`  Pool:     ${p.address} (${p.name})`);
  }

  const http = new ethers.JsonRpcProvider(CONFIG.HTTP_URL);

  if (store.getWatermark() === 0 && process.env.SEED_WATERMARK_ON_FIRST_RUN === 'true') {
    const latest = await http.getBlockNumber();
    const seeded = CONFIG.CONFIRMATIONS > 0 ? (latest - CONFIG.CONFIRMATIONS) : latest;
    store.setWatermark(seeded);
    console.log(`[Seed] Watermark set to ${seeded}`);
  }

  // Startup backfill (bounded by BACKFILL_BLOCKS and confirmations)
  await backfill(http, allAddresses, contractTypes, poolNames);

  /* --- (Re)connectable WS + combined subscription --- */
  async function connectAndSubscribe() {
    if (reconnecting) {
            return; // another caller is already reconnecting
          }
          reconnecting = true;
          try {
                  if (ws) {
                    try {
                      ws.removeAllListeners?.();
                      ws.destroy?.();
                    } catch {}
                    ws = undefined;
                    // tiny backoff to let sockets close
                    await sleep(300);
                  }
            
                  ws = new ethers.WebSocketProvider(CONFIG.WS_URL);
                  await ws.ready;
                  console.log('[WS] ✅ Connection established');
                  reconnectBackoffMs = 1000; // reset backoff on success
                } finally {
                  reconnecting = false; // never get stuck true
                }

    ws.websocket.on('error', (e) => {
      console.error('[WS error]', e?.message || e);
      // Watchdog below will recreate if needed
    });

    ws.websocket.on('close', (code) => {
            console.warn(`[WS] ❌ Connection closed (code=${code}). Reconnecting…`);
            lastWsBlockAt = 0; // mark stalled
            // kick an immediate reconnect (debounced; don’t wait for watchdog)
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            const delay = reconnectBackoffMs;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connectAndSubscribe().catch(e => {
                console.error('[WS] immediate reconnect failed:', e?.message || e);
                reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 30_000); // cap at 30s
              });
              // bump backoff on failure; reset on success in connectAndSubscribe()
            }, delay);
          });

    ws.on('block', (bn) => {
      latestWsBlock = Number(bn);
      lastWsBlockAt = Date.now();
    });

    // Build a single combined subscription across vault + pools
    const addrKind = new Map();
    addrKind.set(vaultAddress, { type: 'vault', name: null });
    addrKind.set(swapperAddress, { type: 'swapper', name: null });
    for (let i = 0; i < poolAddresses.length; i++) {
      addrKind.set(poolAddresses[i], { type: 'pool', name: CONFIG.POOLS[i].name });
    }

    const allAddrs = Array.from(addrKind.keys());
    ws.on({ address: allAddrs }, async (log) => {
      lastAnyLogAt = Date.now();
      const addr = ethers.getAddress(log.address);
      const kind = addrKind.get(addr);
      if (!kind) return;

      const kindLabel = kind.type === 'vault' ? 'Vault' : kind.type === 'swapper' ? 'Swapper' : kind.name;
      console.log(`[WS] ✓ ${kindLabel} event:`,
        log.transactionHash, 'Block:', log.blockNumber, '| topic0=', log.topics?.[0]);

      try {
        if (kind.type === 'vault') await handleVaultLog(http, log);
        else if (kind.type === 'swapper') await handleSwapperLog(http, log);
        else await handlePoolLog(http, log, kind.name);
      } catch (e) {
        console.error(`[Handle ${kindLabel} log error]`, e?.message || e);
      }
    });

    console.log('[Live] Subscribed to vault and', poolAddresses.length, 'pool(s) via one combined filter');
  }

  await connectAndSubscribe();

  // Drain pending once confirmations are met
  setInterval(async () => {
    try {
      const [wsBN, httpBN] = await Promise.all([
        ws?.getBlockNumber?.().catch(() => null),  // Add optional chaining
        http.getBlockNumber().catch(() => null)
      ]);
      const lastLogAgoSec = ((Date.now() - lastAnyLogAt) / 1000) | 0;
      console.log(`[Health] alive ✓ ws=${wsBN ?? 'reconnecting'} http=${httpBN} pending=${pending.size} lastLogAgo=${lastLogAgoSec}s`);
    } catch (e) {
      console.error('[Health] combined check failed:', e?.message || e);
    }
  }, 120_000);

  // Health + visibility (both heights, pending size, idle age)
  setInterval(async () => {
    try {
      const [wsBN, httpBN] = await Promise.all([
        ws.getBlockNumber().catch(() => null),
        http.getBlockNumber().catch(() => null)
      ]);
      const lastLogAgoSec = ((Date.now() - lastAnyLogAt) / 1000) | 0;
      console.log(`[Health] alive ✓ ws=${wsBN} http=${httpBN} pending=${pending.size} lastLogAgo=${lastLogAgoSec}s`);
    } catch (e) {
      console.error('[Health] combined check failed:', e?.message || e);
    }
  }, 120_000);

  // Watchdog: if blocks are ticking but *no logs* for a long time, recreate WS
  setInterval(async () => {
    const idleLogsMs   = Date.now() - lastAnyLogAt;
    const sinceBlockMs = Date.now() - lastWsBlockAt;
    const chainMoving  = sinceBlockMs < WS_BLOCK_STALL_MS;

    // Reconnect if: (A) no logs while chain moving, OR (B) WS hasn't seen blocks for too long (stalled)
    const shouldReconnectA = idleLogsMs > WS_IDLE_MS && chainMoving;
    const shouldReconnectB = sinceBlockMs > WS_BLOCK_STALL_MS; // WS appears stalled
    if (shouldReconnectA || shouldReconnectB) {
      const reason = shouldReconnectA
        ? `no logs for ${(idleLogsMs/1000|0)}s while chain moving (ws≈${latestWsBlock})`
        : `WS stalled (no block events for ${(sinceBlockMs/1000|0)}s)`;
      console.warn(`[WS] Reconnecting due to ${reason}…`);
      try { await connectAndSubscribe(); }
      catch (e) { console.error('[WS] Reconnect failed:', e?.message || e); }
    }
  }, 60_000);

  // Optional sweep backstop to catch anything missed during WS hiccups
  if (SWEEP_INTERVAL_MS !== 0) {
    (async function sweepLoop() {
      while (true) {
        try {
          let latest = await latestBlockSafe(http);
          if (CONFIG.CONFIRMATIONS > 0) latest -= CONFIG.CONFIRMATIONS;

          const from = store.getWatermark() + 1;
          if (from <= latest) {
            await sweepRange(http, from, latest, allAddresses, contractTypes, poolNames);
          }
        } catch (e) {
          console.error('[Sweep] error:', e?.message || e);
        }
        await sleep(SWEEP_INTERVAL_MS);
      }
    })();
  }
}
