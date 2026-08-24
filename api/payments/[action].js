// Ruta dinamica: /api/payments/<action> -> 1 sola funcion serverless (limite Hobby de Vercel).
// Acciones: create-order (auth), status (auth), webhook (publico, verificado por firma de Binance Pay).
// bodyParser off: el webhook necesita los bytes EXACTOS del body para validar la firma RSA
// (re-serializar el JSON parseado por Vercel podria no matchear byte a byte).
export const config = { api: { bodyParser: false }, maxDuration: 30 };

import { requireUser } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { createOrder, queryOrder, verifyWebhookSignature } from '../_lib/binancepay.js';

const TRIAL_DAYS = 7;
const SUB_PRICE = process.env.SUB_PRICE_USDT || '5';
const SUB_CURRENCY = 'USDT';
const PERIOD_MS = 30 * 24 * 3600 * 1000;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

async function ensureSubscription(userId) {
  const rows = await sql`SELECT * FROM subscriptions WHERE user_id = ${userId}`;
  if (rows.length) return rows[0];
  const trialEnd = new Date(Date.now() + TRIAL_DAYS * 24 * 3600 * 1000).toISOString();
  await sql`
    INSERT INTO subscriptions (user_id, status, trial_end)
    VALUES (${userId}, 'trialing', ${trialEnd})
    ON CONFLICT (user_id) DO NOTHING`;
  const out = await sql`SELECT * FROM subscriptions WHERE user_id = ${userId}`;
  return out[0];
}

// Suma 1 periodo desde el vencimiento actual (si ya vencio, desde ahora) — evita
// que pagar temprano "regale" dias por encimarse con el periodo vigente.
async function markPaid(invoiceId, userId, txId) {
  await sql`UPDATE payment_invoices SET status = 'paid', transaction_id = ${txId || null}, paid_at = now() WHERE id = ${invoiceId} AND status = 'pending'`;
  const now = Date.now();
  const sub = await sql`SELECT current_period_end FROM subscriptions WHERE user_id = ${userId}`;
  const curEnd = sub[0] && sub[0].current_period_end ? new Date(sub[0].current_period_end).getTime() : 0;
  const base = curEnd > now ? curEnd : now;
  const periodEnd = new Date(base + PERIOD_MS).toISOString();
  await sql`UPDATE subscriptions SET status = 'active', current_period_end = ${periodEnd}, updated_at = now() WHERE user_id = ${userId}`;
}

function payKeys() {
  return { apiKey: process.env.BINANCE_PAY_API_KEY, secretKey: process.env.BINANCE_PAY_SECRET_KEY };
}

async function createOrderAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {}); // drenar el body (sin datos utiles en esta accion)
  await ensureSchema();
  await ensureSubscription(user.uid);

  const { apiKey, secretKey } = payKeys();
  if (!apiKey || !secretKey) return res.status(500).json({ error: 'Binance Pay no configurado (BINANCE_PAY_API_KEY / BINANCE_PAY_SECRET_KEY)' });

  const merchantTradeNo = 'sub' + user.uid + '_' + Date.now();
  await sql`
    INSERT INTO payment_invoices (id, user_id, provider, amount, currency, status)
    VALUES (${merchantTradeNo}, ${user.uid}, 'binance_pay', ${SUB_PRICE}, ${SUB_CURRENCY}, 'pending')`;

  const { ok, data } = await createOrder(apiKey, secretKey, {
    merchantTradeNo, amount: SUB_PRICE, currency: SUB_CURRENCY,
    goodsName: 'Suscripcion mensual - P2P Monitor',
  });
  if (!ok) {
    await sql`UPDATE payment_invoices SET status = 'failed', raw = ${JSON.stringify(data)}::jsonb WHERE id = ${merchantTradeNo}`;
    return res.status(502).json({ error: 'Binance Pay rechazo la orden', detail: data });
  }
  const d = data.data || {};
  await sql`
    UPDATE payment_invoices SET prepay_id = ${d.prepayId || null}, checkout_url = ${d.checkoutUrl || null},
      qr_content = ${d.qrContent || null}, raw = ${JSON.stringify(data)}::jsonb
    WHERE id = ${merchantTradeNo}`;
  return res.status(200).json({
    invoiceId: merchantTradeNo, amount: SUB_PRICE, currency: SUB_CURRENCY,
    checkoutUrl: d.checkoutUrl, qrcodeLink: d.qrcodeLink, qrContent: d.qrContent,
    deeplink: d.deeplink, expireTime: d.expireTime,
  });
}

async function statusAction(req, res) {
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensureSubscription(user.uid);

  const inv = await sql`SELECT * FROM payment_invoices WHERE user_id = ${user.uid} ORDER BY created_at DESC LIMIT 1`;
  let invoice = inv[0] || null;

  // Respaldo por si el webhook no llego todavia (o no esta configurado en el portal de Binance):
  // el cliente hace polling de /status mientras la factura este pendiente, y aca se
  // pregunta a Binance directamente en cada poll.
  if (invoice && invoice.status === 'pending') {
    const { apiKey, secretKey } = payKeys();
    if (apiKey && secretKey) {
      const { ok, data } = await queryOrder(apiKey, secretKey, invoice.id).catch(() => ({ ok: false }));
      if (ok && data.data) {
        const st = data.data.status;
        if (st === 'PAID') {
          await markPaid(invoice.id, user.uid, data.data.transactionId);
          invoice = (await sql`SELECT * FROM payment_invoices WHERE id = ${invoice.id}`)[0];
        } else if (st === 'CANCELED' || st === 'EXPIRED' || st === 'ERROR') {
          await sql`UPDATE payment_invoices SET status = 'expired' WHERE id = ${invoice.id} AND status = 'pending'`;
          invoice = (await sql`SELECT * FROM payment_invoices WHERE id = ${invoice.id}`)[0];
        }
      }
    }
  }

  const subNow = await sql`SELECT * FROM subscriptions WHERE user_id = ${user.uid}`;
  return res.status(200).json({ subscription: subNow[0] || null, invoice });
}

async function webhookAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawBody = await readRawBody(req);
  const { apiKey, secretKey } = payKeys();
  if (!apiKey || !secretKey) return res.status(500).json({ returnCode: 'FAIL', returnMessage: 'no config' });

  let valid = false;
  try { valid = await verifyWebhookSignature(req.headers, rawBody, apiKey, secretKey); } catch (e) { valid = false; }
  if (!valid) return res.status(401).json({ returnCode: 'FAIL', returnMessage: 'bad signature' });

  let payload = {};
  try { payload = JSON.parse(rawBody || '{}'); } catch (e) {}

  if (payload.bizType === 'PAY') {
    let d = payload.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    d = d || {};
    const merchantTradeNo = d.merchantTradeNo;
    if (merchantTradeNo) {
      await ensureSchema();
      const rows = await sql`SELECT * FROM payment_invoices WHERE id = ${merchantTradeNo}`;
      const invoice = rows[0];
      if (invoice && invoice.status === 'pending') {
        if (payload.bizStatus === 'PAY_SUCCESS') await markPaid(invoice.id, invoice.user_id, d.transactionId);
        else if (payload.bizStatus === 'PAY_CLOSED') await sql`UPDATE payment_invoices SET status = 'expired' WHERE id = ${invoice.id} AND status = 'pending'`;
      }
    }
  }
  // Binance reintenta si la respuesta no tiene exactamente esta forma.
  return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = String(req.query.action || '');
  try {
    switch (action) {
      case 'create-order': return await createOrderAction(req, res);
      case 'status':       return await statusAction(req, res);
      case 'webhook':      return await webhookAction(req, res);
      default:             return res.status(404).json({ error: 'Accion desconocida' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
