import { sql, ensureTelegramLinks } from './db.js';

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

// Resuelve a donde mandar las alertas de UN usuario: el bot compartido
// (TELEGRAM_BOT_TOKEN) al chat privado que esa persona vinculo con el deep link.
// Compartido es solo la identidad del bot — el chat_id es distinto por usuario,
// asi que nadie ve las alertas de nadie.
// Devuelve { token: '', chatId: '' } si no hay vinculo (envio silencioso).
export async function resolveTelegram(userId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { token: '', chatId: '' };
  try {
    await ensureTelegramLinks();
    const rows = await sql`SELECT chat_id FROM telegram_links WHERE user_id = ${userId}`;
    const chatId = rows[0] && rows[0].chat_id;
    return chatId ? { token, chatId } : { token: '', chatId: '' };
  } catch (e) {
    return { token: '', chatId: '' };
  }
}
