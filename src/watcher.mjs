// src/watcher.mjs
// UPDATED: Added chainConfig parameter for multi-chain support
// All chain-specific state is now encapsulated inside startWatcher()

import { ethers } from 'ethers';
import { CONFIG } from './config.mjs';
import vaultAbi from './abi/PermalockVault.json' with { type: 'json' };
import poolAbi from './abi/AerodromePool.json' with { type: 'json' };
import swapperAbi from './abi/RewardSwapper.json' with { type: 'json' };
import { linkTx, linkAddr, prettyArgs, sleep, fmtWei, short, getTokenInfoBatch, fetchPrices, fmtUsd, fmtNumber } from './utils.mjs';
import { sendTelegram } from './notify/telegram.mjs';
import { sendDiscord } from './notify/discord.mjs';
import { createStore, store as legacyStore } from './store.mjs';

/* ---------- ABIs / interfaces (shared across chains) ---------- */
const vaultIface = new ethers.Interface(vaultAbi);
const poolIface  = new ethers.Interface(poolAbi);
const swapperIface = new ethers.Interface(swapperAbi);

/* ---------- Swap signature support (shared) ---------- */
const TOPIC_V2_CLASSIC = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const TOPIC_V2_ALT     = ethers.id('Swap(address,address,uint256,uint256,uint256,uint256)');
const TOPIC_V3         = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TOPIC_PLAN_EXECUTED = ethers.id('PlanExecuted(address,address,uint256,uint256)');
const TOPIC_SWAP_EXECUTED = ethers.id('SwapExecuted(uint8,address,address,uint256,uint256)');

const coder = ethers.AbiCoder.defaultAbiCoder();
const addrFromTopic = (t) => ethers.getAddress(ethers.dataSlice(t, 12));

const ROUTER_NAMES = {
  0: 'Aerodrome',
  1: 'UniV3',
  2: 'Aggregator',
};

function decodeSwapFromTopicsAndData(log) {
  const t0 = log?.topics?.[0];
  if (!t0) return null;

  if (t0 === TOPIC_V2_ALT) {
    const sender = addrFromTopic(log.topics[1]);
    const to = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { kind: 'v2-alt', sender, to, amount0In, amount1In, amount0Out, amount1Out };
  }

  if (t0 === TOPIC_V2_CLASSIC) {
    const sender = addrFromTopic(log.topics[1]);
    const to = addrFromTopic(log.topics[2]);
    const [amount0In, amount1In, amount0Out, amount1Out] =
      coder.decode(['uint256','uint256','uint256','uint256'], log.data);
    return { kind: 'v2-classic', sender, to, amount0In, amount1In, amount0Out, amount1Out };
  }

  if (t0 === TOPIC_V3) {
    const sender = addrFromTopic(log.topics[1]);
    const recipient = addrFromTopic(log.topics[2]);
    const [amount0, amount1] = coder.decode(['int256','int256','uint160','uint128','int24'], log.data);
    const a0 = BigInt(amount0);
    const a1 = BigInt(amount1);
    return {
      kind: 'v3',
      sender,
      to: recipient,
      amount0In: a0 > 0n ? a0 : 0n,
      amount0Out: a0 < 0n ? -a0 : 0n,
      amount1In: a1 > 0n ? a1 : 0n,
      amount1Out: a1 < 0n ? -a1 : 0n,
    };
  }

  return null;
}

/* ---------- Shared pacing for notifications ---------- */
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

/* ---------- Formatting functions (take chain info as params) ---------- */
function formatSwapEvent(poolConfig, argsObj, txHash, address, blockNumber, explorerBase, chainEmoji, chainName) {
  const { sender, to, amount0In, amount1In, amount0Out, amount1Out } = argsObj;
  
  const t0 = poolConfig?.token0 || { symbol: 'token0', decimals: 18 };
  const t1 = poolConfig?.token1 || { symbol: 'token1', decimals: 18 };
  const poolName = poolConfig?.name || 'Unknown Pool';
  
  const fmt = (amt, token) => fmtNumber(Number(ethers.formatUnits(amt, token.decimals)), 4);
  
  let tradeDesc = '';
  if (amount0In > 0n && amount1Out > 0n) {
    tradeDesc = `Bought ${fmt(amount1Out, t1)} ${t1.symbol} (sold ${fmt(amount0In, t0)} ${t0.symbol})`;
  } else if (amount1In > 0n && amount0Out > 0n) {
    tradeDesc = `Bought ${fmt(amount0Out, t0)} ${t0.symbol} (sold ${fmt(amount1In, t1)} ${t1.symbol})`;
  } else {
    tradeDesc = `Swap: ${fmt(amount0In, t0)} ${t0.symbol} in → ${fmt(amount1Out, t1)} ${t1.symbol} out`;
  }
  
  // UPDATED: Added chain emoji and name to header
  const header = `${chainEmoji} **Swap on ${poolName}** (${chainName})\n`;
  const body = `• ${tradeDesc}\n• Sender: \`${short(sender)}\`\n• To: \`${short(to)}\``;
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Pool: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatVaultEvent(name, argsObj, txHash, address, blockNumber, explorerBase, chainEmoji, chainName) {
  // UPDATED: Added chain emoji and name
  const header = `${chainEmoji} **${name}** on *PermalockVault* (${chainName})\n`;
  const body = prettyArgs(argsObj);
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🏷️ Contract: ${linkAddr(explorerBase, address)}\n🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}

function formatPlanExecutedEvent({ caller, recipient, steps, totalOutAmt, swaps, totalUsd, blockNumber, txHash, timestamp, explorerBase, chainEmoji, chainName }) {
  // UPDATED: Added chain emoji and name
  const header = `${chainEmoji} **RewardSwapper Plan Executed** (${chainName})\n`;
  
  let body = '';
  body += `• Steps: ${steps}\n`;
  body += `• Recipient: \`${short(recipient)}\`\n`;
  
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
  
  if (totalUsd > 0) {
    body += `\n💰 **Total Value: ${fmtUsd(totalUsd)}**\n`;
  }
  
  const tsLine = timestamp ? `🕐 ${new Date(timestamp * 1000).toISOString()}\n` : '';
  const footer = `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n🧱 Block: ${blockNumber}`;
  
  return `${tsLine}${header}\n${body}${footer}`;
}

const keyOf = (log) => `${log.transactionHash}:${log.logIndex}`;

function buildArgsObjFromAbiParsed(parsed) {
  const argsObj = {};
  parsed.fragment.inputs.forEach((inp, i) => {
    argsObj[inp.name || `arg${i}`] = parsed.args[i];
  });
  return argsObj;
}

const WS_IDLE_MS = CONFIG.WS_IDLE_MS ?? 10 * 60_000;
const SWEEP_INTERVAL_MS = CONFIG.SWEEP_INTERVAL_MS ?? 15_000;
const WS_BLOCK_STALL_MS = CONFIG.WS_BLOCK_STALL_MS ?? 180_000;

/* ═══════════════════════════════════════════════════════════════════════════
 * UPDATED: startWatcher now accepts chainConfig parameter
 * For backwards compat, chainConfig is optional - falls back to legacy CONFIG
 * ═══════════════════════════════════════════════════════════════════════════ */
export async function startWatcher(chainConfig = null) {
  // ─────────────────────────────────────────────────────────────────────────
  // Chain-specific configuration
  // ─────────────────────────────────────────────────────────────────────────
  const isMultiChain = chainConfig !== null;
  
  const chainKey = chainConfig?.key || 'base';
  const chainName = chainConfig?.name || CONFIG.CHAIN_NAME || 'Base';
  const chainEmoji = chainConfig?.emoji || '🔵';
  const explorerBase = chainConfig?.explorerBase || CONFIG.EXPLORER_BASE;
  const llamaChain = chainConfig?.llamaChain || 'base';
  const wsUrl = chainConfig?.wsUrl || CONFIG.WS_URL;
  const httpUrl = chainConfig?.httpUrl || CONFIG.HTTP_URL;
  const rewardSwapper = chainConfig?.rewardSwapper || CONFIG.REWARD_SWAPPER;
  // FIXED: Only use CONFIG.VAULT in legacy mode (when chainConfig is null)
  // In multi-chain mode, use chainConfig.vault directly (null for non-Base chains)
  const vault = isMultiChain ? (chainConfig.vault || null) : (CONFIG.VAULT || null);
  const pools = isMultiChain ? (chainConfig.pools || []) : (CONFIG.POOLS || []);
  const stablecoins = isMultiChain ? (chainConfig.stablecoins || {}) : (CONFIG.STABLECOINS || {});
  
  const tag = `[${chainEmoji} ${chainName}]`;
  
  // ─────────────────────────────────────────────────────────────────────────
  // Per-chain store (new) vs legacy singleton
  // ─────────────────────────────────────────────────────────────────────────
  const store = isMultiChain ? createStore(chainKey) : legacyStore;
  store.init();
  
  // ─────────────────────────────────────────────────────────────────────────
  // Per-chain state (moved from module level)
  // ─────────────────────────────────────────────────────────────────────────
  let ws;
  let latestWsBlock = 0;
  let lastWsBlockAt = Date.now();
  let lastAnyLogAt = Date.now();
  let reconnecting = false;
  let reconnectTimer = null;
  let reconnectBackoffMs = 1000;
  let lastConnectAt = 0;
  
  const pending = new Map();
  
  const poolConfigByAddr = new Map(
    pools.map(p => [ethers.getAddress(p.address).toLowerCase(), p])
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Helper functions (use chain-specific store and config)
  // ─────────────────────────────────────────────────────────────────────────
  async function latestBlockSafe(http) {
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
    if (store.has(keyOf(log))) return false;
    const wm = store.getWatermark();
    if (log.blockNumber < wm) return false;
    return true;
  }
  
  function enqueuePending(log, contractType, poolName) {
    const k = keyOf(log);
    if (!pending.has(k)) pending.set(k, { log, contractType, poolName });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers (use chain-specific context)
  // ─────────────────────────────────────────────────────────────────────────
  async function handlePoolLog(http, log, poolName) {
    const k = keyOf(log);

    if (!(await hasEnoughConf(http, log))) {
      enqueuePending(log, 'pool', poolName);
      return;
    }
    if (!(await shouldProcess(http, log))) return;

    const { transactionHash, blockNumber, topics, data, address } = log;

    let argsObj = null;
    try {
      const parsed = poolIface.parseLog({ topics, data });
      if (parsed?.name === 'Swap') {
        argsObj = buildArgsObjFromAbiParsed(parsed);
        console.log(`${tag} [Decode] ABI Swap matched (${poolName}) tx=${transactionHash}`);
      }
    } catch {}

    if (!argsObj) {
      const dec = decodeSwapFromTopicsAndData(log);
      if (dec) {
        argsObj = dec;
        console.log(`${tag} [Decode] Fallback ${dec.kind} Swap matched (${poolName}) tx=${transactionHash}`);
      }
    }

    if (!argsObj) return;

    try {
      const blk = await http.getBlock(blockNumber).catch(() => null);
      const tsLine = blk ? `🕐 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
      const poolConfig = poolConfigByAddr.get(address.toLowerCase());
      const msg = `${tsLine}${formatSwapEvent(poolConfig, argsObj, transactionHash, address, blockNumber, explorerBase, chainEmoji, chainName)}`;
      console.log(`${tag} [Notify Swap]`, transactionHash);
      await notifyAll(msg);
      store.markIfNew(k, blockNumber);
    } catch (e) {
      console.error(`${tag} [Notify error]`, e?.message || e);
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
      const msg = `${tsLine}${formatVaultEvent(parsed.name, argsObj, transactionHash, address, blockNumber, explorerBase, chainEmoji, chainName)}`;
      console.log(`${tag} [Notify Vault]`, parsed.name, transactionHash);
      await notifyAll(msg);
      store.markIfNew(k, blockNumber);
    } catch {
      return;
    }
  }

  async function handleSwapperLog(http, log) {
    const k = keyOf(log);

    if (!(await hasEnoughConf(http, log))) {
      enqueuePending(log, 'swapper', null);
      return;
    }
    
    if (store.has(k)) return;

    const { transactionHash, blockNumber, topics, data, address } = log;

    if (topics[0] !== TOPIC_PLAN_EXECUTED) {
      return;
    }

    try {
      const parsed = swapperIface.parseLog({ topics, data });
      if (parsed?.name !== 'PlanExecuted') return;

      const caller = parsed.args[0];
      const recipient = parsed.args[1];
      const steps = Number(parsed.args[2]);
      const totalOutAmt = parsed.args[3];

      console.log(`${tag} [Swapper] PlanExecuted tx=${transactionHash} steps=${steps}`);

      const receipt = await http.getTransactionReceipt(transactionHash);
      const swapperAddr = address.toLowerCase();
      
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
        } catch {}
      }

      const tokenInfoMap = await getTokenInfoBatch(http, Array.from(allTokens));
      
      const outTokens = [...new Set(swapEvents.map(s => s.outToken.toLowerCase()))];
      // UPDATED: Use chain-specific llamaChain for price fetching
      const priceMap = await fetchPrices(outTokens, llamaChain);

      let totalUsd = 0;
      const enrichedSwaps = [];

      for (const s of swapEvents) {
        const inInfo = tokenInfoMap.get(s.tokenIn.toLowerCase()) || { symbol: short(s.tokenIn), decimals: 18 };
        const outInfo = tokenInfoMap.get(s.outToken.toLowerCase()) || { symbol: short(s.outToken), decimals: 18 };
        
        const inHuman = Number(ethers.formatUnits(s.inAmt, inInfo.decimals));
        const outHuman = Number(ethers.formatUnits(s.outAmt, outInfo.decimals));
        
        const stableInfo = stablecoins[s.outToken.toLowerCase()];
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

      const blk = await http.getBlock(blockNumber).catch(() => null);
      const timestamp = blk?.timestamp || null;

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
        explorerBase,
        chainEmoji,
        chainName,
      });

      console.log(`${tag} [Notify Swapper]`, transactionHash, `$${totalUsd.toFixed(2)}`);
      await notifyAll(msg);
      store.markIfNew(k, blockNumber);

    } catch (e) {
      console.error(`${tag} [Swapper] Error handling PlanExecuted:`, e?.message || e);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Backfill & Sweep (use chain-specific store)
  // FIXED: Chunk requests to respect RPC block limits (e.g., Avalanche 10k, Alchemy 10k)
  // ─────────────────────────────────────────────────────────────────────────
  const BACKFILL_CHUNK_SIZE = 2000; // Safe for all RPCs
  
  async function backfill(http, addresses, contractTypes, poolNames) {
    let latest = await http.getBlockNumber();
    if (CONFIG.CONFIRMATIONS > 0) latest -= CONFIG.CONFIRMATIONS;

    const fromWatermark = store.getWatermark() + 1;
    const fromBackfill = CONFIG.BACKFILL_BLOCKS > 0 ? Math.max(0, latest - CONFIG.BACKFILL_BLOCKS) : latest;
    const start = Math.max(fromWatermark, fromBackfill);
    if (start >= latest) return;

    const totalBlocks = latest - start;
    console.log(`${tag} [Backfill] from ${start} to ${latest} (${totalBlocks} blocks)…`);
    
    for (let i = 0; i < addresses.length; i++) {
      let totalLogs = 0;
      
      // Chunk the request to avoid RPC block limits
      for (let chunkStart = start; chunkStart <= latest; chunkStart += BACKFILL_CHUNK_SIZE + 1) {
        const chunkEnd = Math.min(chunkStart + BACKFILL_CHUNK_SIZE, latest);
        
        try {
          const logs = await http.getLogs({ 
            address: addresses[i], 
            fromBlock: chunkStart, 
            toBlock: chunkEnd 
          });
          
          for (const log of logs) {
            if (contractTypes[i] === 'pool') await handlePoolLog(http, log, poolNames[i]);
            else if (contractTypes[i] === 'swapper') await handleSwapperLog(http, log);
            else await handleVaultLog(http, log);
            await sleep(50);
          }
          totalLogs += logs.length;
        } catch (e) {
          console.error(`${tag} [Backfill] chunk ${chunkStart}-${chunkEnd} failed:`, e?.message || e);
          // Continue with next chunk rather than failing entirely
        }
        
        // Small delay between chunks to avoid rate limiting
        await sleep(100);
      }
      
      console.log(`${tag} [Backfill] ${addresses[i]} done (${totalLogs} logs)`);
    }
    store.setWatermark(latest);
  }

  async function sweepRange(http, fromBlock, toBlock, addresses, contractTypes, poolNames) {
    // FIXED: Chunk sweep requests too
    const SWEEP_CHUNK_SIZE = 2000;
    let total = 0;
    
    for (let i = 0; i < addresses.length; i++) {
      for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += SWEEP_CHUNK_SIZE + 1) {
        const chunkEnd = Math.min(chunkStart + SWEEP_CHUNK_SIZE, toBlock);
        
        try {
          const logs = await http.getLogs({ 
            address: addresses[i], 
            fromBlock: chunkStart, 
            toBlock: chunkEnd 
          });
          total += logs.length;
          
          for (const log of logs) {
            if (contractTypes[i] === 'pool') await handlePoolLog(http, log, poolNames[i]);
            else if (contractTypes[i] === 'swapper') await handleSwapperLog(http, log);
            else await handleVaultLog(http, log);
            await sleep(20);
          }
        } catch (e) {
          console.error(`${tag} [Sweep] chunk ${chunkStart}-${chunkEnd} failed:`, e?.message || e);
        }
      }
    }
    if (total === 0) store.setWatermark(toBlock);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Setup addresses to monitor
  // ─────────────────────────────────────────────────────────────────────────
  const swapperAddress = ethers.getAddress(rewardSwapper);
  const vaultAddress = vault ? ethers.getAddress(vault) : null;
  const poolAddresses = pools.map(p => ethers.getAddress(p.address));
  
  // Build address list - always include swapper, optionally vault and pools
  const allAddresses = [swapperAddress];
  const contractTypes = ['swapper'];
  const poolNames = [null];
  
  if (vaultAddress) {
    allAddresses.push(vaultAddress);
    contractTypes.push('vault');
    poolNames.push(null);
  }
  
  for (let i = 0; i < poolAddresses.length; i++) {
    allAddresses.push(poolAddresses[i]);
    contractTypes.push('pool');
    poolNames.push(pools[i].name);
  }

  console.log(`${tag} Monitoring:`);
  console.log(`  Swapper: ${swapperAddress}`);
  if (vaultAddress) console.log(`  Vault:   ${vaultAddress}`);
  for (const p of pools) {
    console.log(`  Pool:    ${p.address} (${p.name})`);
  }

  const http = new ethers.JsonRpcProvider(httpUrl);

  if (store.getWatermark() === 0 && process.env.SEED_WATERMARK_ON_FIRST_RUN === 'true') {
    const latest = await http.getBlockNumber();
    const seeded = CONFIG.CONFIRMATIONS > 0 ? (latest - CONFIG.CONFIRMATIONS) : latest;
    store.setWatermark(seeded);
    console.log(`${tag} [Seed] Watermark set to ${seeded}`);
  }

  await backfill(http, allAddresses, contractTypes, poolNames);

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket connection (uses chain-specific wsUrl)
  // ─────────────────────────────────────────────────────────────────────────
  async function connectAndSubscribe() {
    if (reconnecting) return;
    reconnecting = true;
    try {
      if (ws) {
        try {
          ws.removeAllListeners?.();
          ws.destroy?.();
        } catch {}
        ws = undefined;
        await sleep(300);
      }
  
      ws = new ethers.WebSocketProvider(wsUrl);
      await ws.ready;
      console.log(`${tag} [WS] ✅ Connected`);
      lastConnectAt = Date.now();
    } finally {
      reconnecting = false;
    }
  
    ws.websocket.on('error', (e) => {
      console.error(`${tag} [WS error]`, e?.message || e);
    });
  
    ws.websocket.on('close', (code) => {
      const aliveMs = Date.now() - lastConnectAt;
      console.warn(`${tag} [WS] ❌ Closed (code=${code}, alive=${(aliveMs/1000)|0}s)`);
      lastWsBlockAt = 0;
      
      if (aliveMs > 30_000) {
        reconnectBackoffMs = 1000;
      } else {
        reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 60_000);
        console.warn(`${tag} Unstable, backoff=${reconnectBackoffMs}ms`);
      }
      
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectAndSubscribe().catch(e => {
          console.error(`${tag} [WS] Reconnect failed:`, e?.message || e);
        });
      }, reconnectBackoffMs);
    });

    ws.on('block', (bn) => {
      latestWsBlock = Number(bn);
      lastWsBlockAt = Date.now();
    });

    // Build address lookup
    const addrKind = new Map();
    addrKind.set(swapperAddress, { type: 'swapper', name: null });
    if (vaultAddress) {
      addrKind.set(vaultAddress, { type: 'vault', name: null });
    }
    for (let i = 0; i < poolAddresses.length; i++) {
      addrKind.set(poolAddresses[i], { type: 'pool', name: pools[i].name });
    }

    const allAddrs = Array.from(addrKind.keys()).map(a => a.toLowerCase());
    ws.on({ address: allAddrs }, async (log) => {
      lastAnyLogAt = Date.now();
      const addr = ethers.getAddress(log.address);
      const kind = addrKind.get(addr);
      if (!kind) return;

      const kindLabel = kind.type === 'vault' ? 'Vault' : kind.type === 'swapper' ? 'Swapper' : kind.name;
      console.log(`${tag} [WS] Event: ${kindLabel}`, log.transactionHash, 'Block:', log.blockNumber);

      try {
        if (kind.type === 'vault') await handleVaultLog(http, log);
        else if (kind.type === 'swapper') await handleSwapperLog(http, log);
        else await handlePoolLog(http, log, kind.name);
      } catch (e) {
        console.error(`${tag} [Handle error]`, e?.message || e);
      }
    });

    console.log(`${tag} [Live] Subscribed to ${allAddrs.length} address(es)`);
  }

  await connectAndSubscribe();

  // Health check
  setInterval(async () => {
    try {
      const [wsBN, httpBN] = await Promise.all([
        ws?.getBlockNumber?.().catch(() => null),
        http.getBlockNumber().catch(() => null)
      ]);
      const lastLogAgoSec = ((Date.now() - lastAnyLogAt) / 1000) | 0;
      console.log(`${tag} [Health] ✓ ws=${wsBN ?? 'reconnecting'} http=${httpBN} pending=${pending.size} lastLogAgo=${lastLogAgoSec}s`);
    } catch (e) {
      console.error(`${tag} [Health] check failed:`, e?.message || e);
    }
  }, 120_000);

  // WS watchdog
  setInterval(async () => {
    const idleLogsMs = Date.now() - lastAnyLogAt;
    const sinceBlockMs = Date.now() - lastWsBlockAt;
    const chainMoving = sinceBlockMs < WS_BLOCK_STALL_MS;

    const shouldReconnectA = idleLogsMs > WS_IDLE_MS && chainMoving;
    const shouldReconnectB = sinceBlockMs > WS_BLOCK_STALL_MS;
    if (shouldReconnectA || shouldReconnectB) {
      const reason = shouldReconnectA
        ? `no logs for ${(idleLogsMs/1000|0)}s while chain moving (ws≈${latestWsBlock})`
        : `WS stalled (no block events for ${(sinceBlockMs/1000|0)}s)`;
      console.warn(`${tag} [WS] Reconnecting: ${reason}`);
      try { await connectAndSubscribe(); }
      catch (e) { console.error(`${tag} [WS] Reconnect failed:`, e?.message || e); }
    }
  }, 60_000);

  // Sweep backstop
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
          console.error(`${tag} [Sweep] error:`, e?.message || e);
        }
        await sleep(SWEEP_INTERVAL_MS);
      }
    })();
  }

  console.log(`${tag} Watcher started ✅`);
  return { chainKey, store };
}
