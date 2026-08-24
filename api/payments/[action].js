// Ruta dinamica: /api/payments/<action> -> 1 sola funcion serverless (limite Hobby de Vercel).
// Acciones: create-order (auth), status (auth), webhook (publico, verificado por firma de Binance Pay).
// bodyParser off: el webhook necesita los bytes EXACTOS del body para validar la firma RSA
// (re-serializar el JSON parseado por Vercel podria no matchear byte a byte).
export const config = { api: { bodyParser: false }, maxDuration: 30 };

import { requireUser } from '../_lib/auth.js';
import { sql, ensureSchema, ensurePlanColumn } from '../_lib/db.js';
import { createOrder, queryOrder, verifyWebhookSignature } from '../_lib/binancepay.js';
import { sendPush } from '../_lib/push.js';
import { ensureSubscription, startTrial, markPaid, planInfo, PLANS, SUB_CURRENCY } from '../_lib/subscriptions.js';

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

function payKeys() {
  return { apiKey: process.env.BINANCE_PAY_API_KEY, secretKey: process.env.BINANCE_PAY_SECRET_KEY };
}

async function createOrderAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const body = await readJsonBody(req);
  const plan = body.plan === 'annual' ? 'annual' : 'monthly';
  await ensureSchema();
  await ensurePlanColumn();
  await ensureSubscription(user.uid);

  const { apiKey, secretKey } = payKeys();
  if (!apiKey || !secretKey) return res.status(500).json({ error: 'Binance Pay no configurado (BINANCE_PAY_API_KEY / BINANCE_PAY_SECRET_KEY)' });

  const price = PLANS[plan].price;
  const merchantTradeNo = 'sub' + user.uid + '_' + Date.now();
  await sql`
    INSERT INTO payment_invoices (id, user_id, provider, amount, currency, status, plan)
    VALUES (${merchantTradeNo}, ${user.uid}, 'binance_pay', ${price}, ${SUB_CURRENCY}, 'pending', ${plan})`;

  const { ok, data } = await createOrder(apiKey, secretKey, {
    merchantTradeNo, amount: price, currency: SUB_CURRENCY,
    goodsName: (plan === 'annual' ? 'Suscripcion anual' : 'Suscripcion mensual') + ' - P2P Monitor',
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
    invoiceId: merchantTradeNo, amount: price, currency: SUB_CURRENCY,
    checkoutUrl: d.checkoutUrl, qrcodeLink: d.qrcodeLink, qrContent: d.qrContent,
    deeplink: d.deeplink, expireTime: d.expireTime,
  });
}

async function statusAction(req, res) {
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensurePlanColumn();
  await ensureSubscription(user.uid);

  const inv = await sql`SELECT * FROM payment_invoices WHERE user_id = ${user.uid} ORDER BY created_at DESC LIMIT 1`;
  let invoice = inv[0] || null;

  // Respaldo por si el webhook no llego todavia (o no esta configurado en el portal de Binance):
  // el cliente hace polling de /status mientras la factura este pendiente, y aca se
  // pregunta a Binance directamente en cada poll.
  if (invoice && invoice.status === 'pending' && invoice.provider === 'binance_pay' && invoice.prepay_id) {
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
  return res.status(200).json({
    subscription: subNow[0] || null, invoice,
    plans: planInfo(), currency: SUB_CURRENCY,
  });
}

// El usuario paga por el Payment Link compartido (cuenta personal de Binance Pay,
// sin cuenta Entity/Merchant) y avisa aca: crea una factura en revision y te
// notifica por push para que la confirmes vos a mano contra el historial de Binance Pay.
async function markPendingAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const body = await readJsonBody(req);
  const plan = body.plan === 'annual' ? 'annual' : 'monthly';
  await ensureSchema();
  await ensurePlanColumn();
  await ensureSubscription(user.uid);

  // Si ya hay una factura pendiente de revision, no duplicar.
  const existing = await sql`SELECT id FROM payment_invoices WHERE user_id = ${user.uid} AND status = 'pending_review'`;
  if (existing.length) return res.status(200).json({ invoiceId: existing[0].id, status: 'pending_review' });

  const price = PLANS[plan].price;
  const invoiceId = 'man' + user.uid + '_' + Date.now();
  await sql`
    INSERT INTO payment_invoices (id, user_id, provider, amount, currency, status, plan)
    VALUES (${invoiceId}, ${user.uid}, 'binance_pay_link', ${price}, ${SUB_CURRENCY}, 'pending_review', ${plan})`;

  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  if (adminId) {
    sendPush(adminId, '💳 Pago por confirmar',
      'Usuario #' + user.uid + ' (' + user.email + ') dice haber pagado ' + price + ' ' + SUB_CURRENCY + ' (' + plan + ')'
    ).catch(() => {});
  }
  return res.status(200).json({ invoiceId, status: 'pending_review' });
}

// Activa la prueba gratis (7 dias) — solo cuando el usuario lo pide explicitamente,
// nunca automatico al entrar.
async function startTrialAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensureSubscription(user.uid);
  const sub = await startTrial(user.uid);
  if (!sub) return res.status(409).json({ error: 'La prueba ya fue activada antes' });
  return res.status(200).json({ subscription: sub });
}

// Nick de Binance Pay del usuario: es la unica forma de distinguir pagos simultaneos
// del mismo monto fijo cuando el poller de correo (mail-poll.js) intente matchearlos.
async function setNickAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const body = await readJsonBody(req);
  const nick = String(body.nick || '').trim().slice(0, 64);
  if (!nick) return res.status(400).json({ error: 'nick requerido' });
  await ensureSchema();
  await ensureSubscription(user.uid);
  await sql`UPDATE subscriptions SET binance_nick = ${nick}, updated_at = now() WHERE user_id = ${user.uid}`;
  return res.status(200).json({ ok: true });
}

// Confirmacion manual del admin (revisa el historial de Binance Pay a mano). Restringido
// a ADMIN_EMAIL para no dejar que cualquier usuario se autoconfirme la suscripcion.
async function adminConfirmAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || user.email !== adminEmail) return res.status(403).json({ error: 'No autorizado' });

  const body = await readJsonBody(req);
  const invoiceId = String(body.invoiceId || '');
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId requerido' });
  await ensureSchema();
  await ensurePlanColumn();
  const rows = await sql`SELECT * FROM payment_invoices WHERE id = ${invoiceId}`;
  const invoice = rows[0];
  if (!invoice) return res.status(404).json({ error: 'Factura no encontrada' });
  if (invoice.status !== 'pending' && invoice.status !== 'pending_review') {
    return res.status(409).json({ error: 'Factura ya resuelta (' + invoice.status + ')' });
  }
  await markPaid(invoice.id, invoice.user_id, body.txId || null);
  return res.status(200).json({ ok: true });
}

// Lista de facturas en revision para el admin (dashboard minimo: solo lectura).
async function adminPendingAction(req, res) {
  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || user.email !== adminEmail) return res.status(403).json({ error: 'No autorizado' });
  await readRawBody(req).catch(() => {});
  await ensureSchema();
  await ensurePlanColumn();
  const rows = await sql`
    SELECT i.id, i.user_id, u.email, i.amount, i.currency, i.plan, i.status, i.created_at
    FROM payment_invoices i JOIN users u ON u.id = i.user_id
    WHERE i.status IN ('pending', 'pending_review')
    ORDER BY i.created_at ASC`;
  return res.status(200).json({ invoices: rows });
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
      await ensurePlanColumn();
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
      case 'create-order':  return await createOrderAction(req, res);
      case 'status':        return await statusAction(req, res);
      case 'webhook':       return await webhookAction(req, res);
      case 'mark-pending':  return await markPendingAction(req, res);
      case 'start-trial':   return await startTrialAction(req, res);
      case 'set-nick':      return await setNickAction(req, res);
      case 'admin-confirm': return await adminConfirmAction(req, res);
      case 'admin-pending': return await adminPendingAction(req, res);
      default:              return res.status(404).json({ error: 'Accion desconocida' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
