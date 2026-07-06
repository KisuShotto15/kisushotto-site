// Web Push (VAPID) server-side: notificaciones del sistema aunque la app este
// cerrada, sin depender de Telegram. Claves en env: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
import webpush from 'web-push';
import { sql } from './db.js';

let configured = false;
function ensureVapid() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails('mailto:efrenalejandro2010@gmail.com', pub, priv);
  configured = true;
  return true;
}

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

// Envia a todos los dispositivos del usuario; poda suscripciones muertas (404/410).
export async function sendPush(userId, title, body) {
  if (!ensureVapid()) return false;
  let rows;
  try { rows = await sql`SELECT endpoint, sub FROM push_subs WHERE user_id = ${userId}`; }
  catch (e) { return false; }
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification(r.sub, JSON.stringify({ title, body }), { TTL: 3600 });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try { await sql`DELETE FROM push_subs WHERE endpoint = ${r.endpoint}`; } catch (e2) {}
      }
    }
  }
  return sent > 0;
}

// Texto plano para push (los mensajes de Telegram traen HTML)
export function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
