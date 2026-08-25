// Ruta dinamica: /api/telegram/<action> -> 1 sola funcion serverless (limite Hobby).
// Vinculacion del bot compartido por deep link: el usuario nunca ve un token ni
// tiene que averiguar su chat ID. Toca "Conectar", Telegram abre el chat con el bot,
// pulsa Iniciar, y el webhook saca el chat.id del propio mensaje.
export const config = { api: { bodyParser: false }, maxDuration: 15 };

import crypto from 'node:crypto';
import { requireUser } from '../_lib/auth.js';
import { sql, ensureSchema, ensureTelegramLinks } from '../_lib/db.js';
import { sendTelegram } from '../_lib/telegram.js';

const CODE_TTL_MIN = 15;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function botUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
}

// Codigo del deep link: va en una URL publica (t.me/...?start=CODE), asi que se
// genera con aleatoriedad criptografica y caduca a los 15 min.
function newCode() {
  return crypto.randomBytes(9).toString('base64url');
}

// Genera (o reusa) el codigo del usuario y devuelve el deep link.
async function linkAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  const uname = botUsername();
  if (!process.env.TELEGRAM_BOT_TOKEN || !uname) {
    return res.status(500).json({ error: 'Falta TELEGRAM_BOT_TOKEN o TELEGRAM_BOT_USERNAME' });
  }
  await ensureSchema();
  await ensureTelegramLinks();

  const code = newCode();
  await sql`
    INSERT INTO telegram_links (user_id, code, code_expires)
    VALUES (${user.uid}, ${code}, now() + ${CODE_TTL_MIN + ' minutes'}::interval)
    ON CONFLICT (user_id) DO UPDATE SET code = ${code},
      code_expires = now() + ${CODE_TTL_MIN + ' minutes'}::interval`;
  return res.status(200).json({ url: 'https://t.me/' + uname + '?start=' + code });
}

async function statusAction(req, res) {
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensureTelegramLinks();
  const rows = await sql`SELECT chat_id FROM telegram_links WHERE user_id = ${user.uid}`;
  return res.status(200).json({
    linked: !!(rows[0] && rows[0].chat_id),
    available: !!(process.env.TELEGRAM_BOT_TOKEN && botUsername()),
  });
}

async function unlinkAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensureTelegramLinks();
  await sql`DELETE FROM telegram_links WHERE user_id = ${user.uid}`;
  return res.status(200).json({ ok: true });
}

// Webhook publico de Telegram. Se autentica con el secret que Telegram devuelve en
// la cabecera X-Telegram-Bot-Api-Secret-Token (lo fija setWebhook, ver setupAction).
async function webhookAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const raw = await readRawBody(req);
  let update = {};
  try { update = JSON.parse(raw || '{}'); } catch (e) {}

  const msg = update.message || update.edited_message;
  const text = String((msg && msg.text) || '');
  const chatId = msg && msg.chat && msg.chat.id;
  const m = text.match(/^\/start\s+(\S+)/);
  // Telegram reintenta si no respondemos 200; cualquier update que no sea un
  // /start con codigo simplemente se ignora.
  if (!m || !chatId) return res.status(200).json({ ok: true });

  await ensureSchema();
  await ensureTelegramLinks();
  const upd = await sql`
    UPDATE telegram_links SET chat_id = ${String(chatId)}, linked_at = now(),
      code = NULL, code_expires = NULL
    WHERE code = ${m[1]} AND code_expires > now()
    RETURNING user_id`;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  await sendTelegram(token, chatId, upd.length
    ? '✅ <b>Listo.</b> Vas a recibir aquí tus alertas de P2P Monitor.'
    : '⚠️ Ese enlace ya venció o no es válido. Genera uno nuevo desde la app.'
  ).catch(() => {});
  return res.status(200).json({ ok: true });
}

// Registra el webhook en Telegram (una vez, tras configurar las env vars).
// Restringido al admin para no exponer el token del bot.
async function setupAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || user.email !== adminEmail) return res.status(403).json({ error: 'No autorizado' });
  await readRawBody(req).catch(() => {});

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = process.env.PUBLIC_API_BASE || 'https://kisushotto-site.vercel.app';
  if (!token || !secret) return res.status(500).json({ error: 'Falta TELEGRAM_BOT_TOKEN o TELEGRAM_WEBHOOK_SECRET' });

  const r = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: base + '/api/telegram/webhook',
      secret_token: secret,
      allowed_updates: ['message'],
    }),
  });
  const data = await r.json().catch(() => ({}));
  return res.status(r.ok ? 200 : 502).json(data);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = String(req.query.action || '');
  try {
    switch (action) {
      case 'link':    return await linkAction(req, res);
      case 'status':  return await statusAction(req, res);
      case 'unlink':  return await unlinkAction(req, res);
      case 'webhook': return await webhookAction(req, res);
      case 'setup':   return await setupAction(req, res);
      default:        return res.status(404).json({ error: 'Accion desconocida' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
