// Reconcilia los pagos de suscripcion contra el historial de Binance Pay del dueño
// (GET /sapi/v1/pay/transactions, API Spot normal — NO hace falta cuenta Merchant).
// Sustituye al poller de correo: en vez de esperar un mail de confirmacion, se le
// pregunta a Binance directamente.
//
// A DEMANDA, como el de correo: lo dispara /api/payments cuando el usuario avisa
// "Ya pague" o mientras hace polling con una factura en revision. El endpoint pesa
// 3000 de los 6000/min que da Binance, asi que el throttle no es opcional.
import crypto from 'node:crypto';
import { sql, ensurePlanColumn, ensurePayState, ensureNickColumn } from './db.js';
import { markPaid } from './subscriptions.js';
import { payerMatches } from './payer-match.js';

const BINANCE = 'https://api.binance.com';
const POLL_THROTTLE_MS = 20 * 1000;
// Ventana de busqueda: el usuario paga y DESPUES pulsa "Ya pague", asi que la
// transaccion es anterior a la factura. 24h cubre de sobra cualquier despiste.
const LOOKBACK_MS = 24 * 3600 * 1000;
const AMOUNT_EPS = 0.01;

export function payKeys() {
  return {
    key: process.env.ADMIN_BINANCE_API_KEY || '',
    secret: process.env.ADMIN_BINANCE_SECRET_KEY || '',
  };
}

// Historial de Binance Pay del dueño de las claves. Firma HMAC-SHA256 sobre la
// query, igual que el resto de la API Spot.
export async function getPayTransactions(key, secret, startTime) {
  const qs = `startTime=${startTime}&limit=100&timestamp=${Date.now()}`;
  const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const r = await fetch(`${BINANCE}/sapi/v1/pay/transactions?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    const e = new Error(data.msg || data.message || `HTTP ${r.status}`);
    e.code = data.code;
    throw e;
  }
  return Array.isArray(data.data) ? data.data : [];
}

async function shouldPoll() {
  const rows = await sql`SELECT pay_checked_at FROM email_payment_state WHERE id = 1`;
  const last = rows[0] && rows[0].pay_checked_at ? new Date(rows[0].pay_checked_at).getTime() : 0;
  return Date.now() - last >= POLL_THROTTLE_MS;
}

// Vence las facturas abandonadas: sin esto, un "Ya pague" falso se queda pendiente
// para siempre y le roba el pago al siguiente que si pague por el mismo monto.
async function expireStale() {
  await sql`
    UPDATE payment_invoices SET status = 'expired'
    WHERE status IN ('pending', 'pending_review') AND created_at < now() - interval '48 hours'`;
}

// Solo cobros entrantes: en el historial, lo que el dueño paga viene en negativo.
function isIncoming(t) {
  return Number(t.amount) > 0;
}

// Casa transacciones con facturas por monto y moneda. El transaction_id de Binance
// se guarda en la factura, asi que un mismo pago no puede confirmar dos facturas.
export async function checkPayPayments(force) {
  await ensurePayState();
  if (!force && !(await shouldPoll())) return { skipped: 'throttled' };
  await ensurePlanColumn();
  await ensureNickColumn();
  await expireStale();

  const { key, secret } = payKeys();
  if (!key || !secret) {
    await sql`UPDATE email_payment_state SET pay_checked_at = now() WHERE id = 1`;
    return { skipped: 'no-config' };
  }

  const pend = await sql`
    SELECT i.id, i.user_id, i.amount, i.currency, s.binance_nick
    FROM payment_invoices i
    LEFT JOIN subscriptions s ON s.user_id = i.user_id
    WHERE i.status IN ('pending', 'pending_review')
    ORDER BY i.created_at ASC`;
  if (!pend.length) {
    await sql`UPDATE email_payment_state SET pay_checked_at = now() WHERE id = 1`;
    return { pending: 0, matched: 0 };
  }

  let txs;
  try {
    txs = await getPayTransactions(key, secret, Date.now() - LOOKBACK_MS);
  } catch (e) {
    await sql`UPDATE email_payment_state SET pay_checked_at = now() WHERE id = 1`;
    return { error: e.message, code: e.code };
  }

  const used = await sql`
    SELECT transaction_id FROM payment_invoices
    WHERE transaction_id IS NOT NULL AND paid_at > now() - interval '30 days'`;
  const usedIds = new Set(used.map(r => r.transaction_id));

  const incoming = txs.filter(isIncoming).sort((a, b) => a.transactionTime - b.transactionTime);
  let matched = 0, noNick = 0;
  for (const inv of pend) {
    // Sin nick no se confirma sola: el monto por si solo no distingue la suscripcion
    // de cualquier otro cobro de USDT, y aca entran pagos de P2P todo el dia. Esas
    // facturas quedan para el panel manual.
    if (!inv.binance_nick) { noNick++; continue; }
    const hit = incoming.find(t =>
      !usedIds.has(String(t.transactionId)) &&
      String(t.currency).toUpperCase() === String(inv.currency).toUpperCase() &&
      Math.abs(Number(t.amount) - Number(inv.amount)) <= AMOUNT_EPS &&
      payerMatches(t, inv.binance_nick)
    );
    if (!hit) continue;
    if (await markPaid(inv.id, inv.user_id, String(hit.transactionId))) {
      usedIds.add(String(hit.transactionId));
      matched++;
    }
  }

  await sql`UPDATE email_payment_state SET pay_checked_at = now() WHERE id = 1`;
  return { pending: pend.length, seen: txs.length, incoming: incoming.length, matched, noNick };
}

// Diagnostico del panel de admin: responde si las claves sirven y que se ve, sin
// tocar ninguna factura.
export async function probePayTransactions() {
  const { key, secret } = payKeys();
  if (!key || !secret) return { ok: false, reason: 'Falta ADMIN_BINANCE_API_KEY / ADMIN_BINANCE_SECRET_KEY' };
  try {
    const txs = await getPayTransactions(key, secret, Date.now() - LOOKBACK_MS);
    return {
      ok: true,
      total: txs.length,
      incoming: txs.filter(isIncoming).length,
      last: txs.slice(0, 3).map(t => ({
        amount: t.amount, currency: t.currency,
        when: t.transactionTime ? new Date(t.transactionTime).toISOString() : null,
      })),
    };
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code };
  }
}
