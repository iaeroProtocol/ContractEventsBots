import { CONFIG } from '../config.mjs';

const TG = CONFIG.TELEGRAM;

export async function sendTelegram(text) {
  if (!TG.TOKEN || !TG.CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG.TOKEN}/sendMessage`;
  const body = {
    chat_id: TG.CHAT_ID,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('[Telegram] Failed:', res.status, t);
    }
  } catch (e) {
    console.error('[Telegram] Error:', e.message);
  }
}

