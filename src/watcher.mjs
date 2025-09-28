// src/watcher.mjs
import { ethers } from 'ethers';
import { CONFIG } from './config.mjs';
import abi from './abi/PermalockVault.json' with { type: 'json' };
import { linkTx, linkAddr, prettyArgs, sleep } from './utils.mjs';
import { sendTelegram } from './notify/telegram.mjs';
import { sendDiscord } from './notify/discord.mjs';
import { store } from './store.mjs';

const iface = new ethers.Interface(abi);

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
function formatDecodedEvent(name, argsObj, txHash, address, blockNumber, explorerBase) {
  const header = `**${name}** on *PermalockVault*\n`;
  const body   = prettyArgs(argsObj);
  const footer =
    `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n` +
    `🏷️ Contract: ${linkAddr(explorerBase, address)}\n` +
    `🧱 Block: ${blockNumber}`;
  return `${header}\n${body}\n${footer}`;
}
function formatUnknownEvent(topic0, data, txHash, address, blockNumber, explorerBase) {
  const header = `**Unknown event** (topic0: \`${topic0}\`)`;
  const body   = `data: \`${(data||'0x').slice(0, 200)}${(data||'').length>200?'…':''}\``;
  const footer =
    `\n🔗 Tx: ${linkTx(explorerBase, txHash)}\n` +
    `🏷️ Contract: ${linkAddr(explorerBase, address)}\n` +
    `🧱 Block: ${blockNumber}`;
  return `${header}\n\n${body}\n${footer}`;
}

/* ---------- dedupe / confirmations ---------- */
/** true if this log should be posted (not duplicate, confirmed enough) */
async function shouldProcess(http, log) {
  const key = `${log.transactionHash}:${log.logIndex}`;

  // already seen?
  if (store.has(key)) return false;

  // confirmations (optional)
  if (CONFIG.CONFIRMATIONS > 0) {
    const latest = await http.getBlockNumber();
    if (log.blockNumber > latest - CONFIG.CONFIRMATIONS) {
      // not enough confirmations yet; skip for now
      return false;
    }
  }

  // watermark: ignore anything at or below lastProcessedBlock
  const wm = store.getWatermark();
  if (log.blockNumber <= wm) return false;

  return true;
}

async function handleLog(http, log) {
  if (!(await shouldProcess(http, log))) return;

  const { transactionHash, blockNumber, topics, data, address } = log;
  const key = `${transactionHash}:${log.logIndex}`;

  let text;
  try {
    const parsed = iface.parseLog({ topics, data });
    const argsObj = {};
    parsed.fragment.inputs.forEach((inp, i) => {
      argsObj[inp.name || `arg${i}`] = parsed.args[i];
    });
    text = formatDecodedEvent(parsed.name, argsObj, transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
  } catch {
    text = formatUnknownEvent(topics?.[0] || '0x', data || '0x', transactionHash, address, blockNumber, CONFIG.EXPLORER_BASE);
  }

  try {
    // timestamp (optional)
    const blk = await http.getBlock(blockNumber).catch(() => null);
    const tsLine = blk ? `🕒 ${new Date(blk.timestamp * 1000).toISOString()}\n` : '';
    await notifyAll(`${tsLine}${text}`);

    // mark as seen AFTER successful notify
    store.markIfNew(key, blockNumber);
  } catch (e) {
    console.error('[Notify error]', e?.message || e);
    // do not mark; will retry on next run
  }
}

/* ---------- backfill ---------- */
async function backfill(http, address) {
  // Latest minus confirmations (if any) as an upper bound
  let latest = await http.getBlockNumber();
  if (CONFIG.CONFIRMATIONS > 0) latest -= CONFIG.CONFIRMATIONS;

  const fromWatermark = store.getWatermark() + 1;
  const fromBackfill  = CONFIG.BACKFILL_BLOCKS > 0 ? Math.max(0, latest - CONFIG.BACKFILL_BLOCKS) : latest;
  const start         = Math.max(fromWatermark, fromBackfill);

  if (start >= latest) return;

  console.log(`[Backfill] from ${start} to ${latest}…`);
  const logs = await http.getLogs({ address, fromBlock: start, toBlock: latest });

  for (const log of logs) {
    await handleLog(http, log);
    // gentle pacing; the Discord queue also respects rate limits
    await sleep(100);
  }
  console.log(`[Backfill] done (${logs.length} logs)`);

  // advance watermark to latest bound
  store.setWatermark(latest);
}

/* ---------- start watcher ---------- */
export async function startWatcher() {
  store.init();

  const address = ethers.getAddress(CONFIG.VAULT);
  const http    = new ethers.JsonRpcProvider(CONFIG.HTTP_URL);

  // Optional: seed watermark to "now" on first boot to avoid posting history
  if (store.getWatermark() === 0 && process.env.SEED_WATERMARK_ON_FIRST_RUN === 'true') {
    const latest = await http.getBlockNumber();
    const seeded = CONFIG.CONFIRMATIONS > 0 ? (latest - CONFIG.CONFIRMATIONS) : latest;
    store.setWatermark(seeded);
    console.log(`[Seed] Watermark set to ${seeded}; skipping history this run`);
  }

  await backfill(http, address);

  const ws = new ethers.WebSocketProvider(CONFIG.WS_URL);
  // (optional) this may not be a recognized provider event on all providers;
  // if you see another "unknown ProviderEvent 'error'" remove this line too.
  ws.on('error', (e) => console.error('[WS error]', e?.message || e));

  const filter = { address }; // you can add topics here if you want to narrow
  ws.on(filter, async (log) => {
    try { await handleLog(http, log); }
    catch (e) { console.error('[Handle log error]', e?.message || e); }
  });


  console.log('[Live] Subscribed for logs on', address);
}
