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
