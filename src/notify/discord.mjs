// src/notify/discord.mjs
import { CONFIG } from '../config.mjs';
import { sleep } from '../utils.mjs';

// Support multiple webhooks via comma-separated env (optional)
const hooks = (CONFIG.DISCORD.WEBHOOK_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Per-webhook queue and processor
const queues = new Map();      // url -> Array<string>
const processing = new Map();  // url -> boolean

function enqueue(url, content) {
  if (!queues.has(url)) queues.set(url, []);
  queues.get(url).push(content);
  if (!processing.get(url)) processQueue(url);
}

async function processQueue(url) {
  if (processing.get(url)) return;
  processing.set(url, true);
  try {
    const q = queues.get(url) || [];
    while (q.length) {
      const content = q[0]; // peek
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
          // To use embeds instead, swap body to:
          // body: JSON.stringify({ embeds: [{ title:'PermalockVault Event', description: content, color: 0x2dd4bf }] })
        });

        if (res.status === 429) {
          // Respect Discord rate-limit header/body
          let waitMs = 1500;
          try {
            const body = await res.json();
            if (typeof body?.retry_after === 'number') {
              waitMs = Math.ceil(body.retry_after * 1000) + 250;
            }
          } catch {}
          console.warn('[Discord] 429, waiting', waitMs, 'ms');
          await sleep(waitMs);
          // do NOT shift; retry same content
          continue;
        }

        if (!res.ok) {
          const t = await res.text().catch(() => '');
          console.error('[Discord] Failed:', res.status, t);
          // drop this message to avoid jam; or you can requeue once
          q.shift();
          // small delay to be polite
          await sleep(300);
          continue;
        }

        // ok
        q.shift();
        // simple pacing (webhook limit ~5 req / 2s)
        await sleep(Math.max(CONFIG.MIN_MS_BETWEEN_MSGS, 500));
      } catch (e) {
        console.error('[Discord] Error:', e?.message || e);
        // transient: wait and retry same content
        await sleep(1000);
      }
    }
  } finally {
    processing.set(url, false);
  }
}

export async function sendDiscord(content) {
  if (!hooks.length) return;
  for (const url of hooks) enqueue(url, content);
}
