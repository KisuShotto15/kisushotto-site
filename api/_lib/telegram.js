import { sql, ensureTelegramLinks } from './db.js';
import { decrypt } from './crypto.js';

// Envio de mensajes a Telegram (server-side). El monitor 24/7 lo usa para alertar
// aunque la app este cerrada.
export async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Resuelve a donde mandar las alertas de UN usuario. Prioridad:
//  1. Bot propio (token + chat id en la config "avanzada") — para quien ya lo tenia.
//  2. Bot compartido (TELEGRAM_BOT_TOKEN) + el chat privado que ese usuario vinculo
//     con el deep link. Compartido es solo la identidad del bot: el chat_id es
//     distinto por persona, asi que nadie ve las alertas de nadie.
// Devuelve { token: '', chatId: '' } si no hay nada configurado (envio silencioso).
export async function resolveTelegram(userId, cfg) {
  let token = '';
  try { token = (cfg && cfg.tg && cfg.tg.token_enc) ? decrypt(cfg.tg.token_enc) : ''; } catch (e) {}
  const ownChat = (cfg && cfg.tg && cfg.tg.chatId) || '';
  if (token && ownChat) return { token, chatId: ownChat };

  const shared = process.env.TELEGRAM_BOT_TOKEN;
  if (!shared) return { token: '', chatId: '' };
  try {
    await ensureTelegramLinks();
    const rows = await sql`SELECT chat_id FROM telegram_links WHERE user_id = ${userId}`;
    const chatId = rows[0] && rows[0].chat_id;
    return chatId ? { token: shared, chatId } : { token: '', chatId: '' };
  } catch (e) {
    return { token: '', chatId: '' };
  }
}
