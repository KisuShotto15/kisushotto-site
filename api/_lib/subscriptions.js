// Logica de suscripcion compartida entre la ruta HTTP (/api/payments) y el poller
// de correo (mail-poll.js), para no duplicar el criterio de "que significa pagar".
import { sql } from './db.js';

export const TRIAL_DAYS = 7;
export const SUB_PRICE = process.env.SUB_PRICE_USDT || '5';
export const SUB_CURRENCY = 'USDT';
export const PERIOD_MS = 30 * 24 * 3600 * 1000;

export async function ensureSubscription(userId) {
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
export async function markPaid(invoiceId, userId, txId) {
  const upd = await sql`
    UPDATE payment_invoices SET status = 'paid', transaction_id = ${txId || null}, paid_at = now()
    WHERE id = ${invoiceId} AND status IN ('pending', 'pending_review')
    RETURNING id`;
  if (!upd.length) return false; // ya estaba resuelta (evita doble conteo de periodo)
  const now = Date.now();
  const sub = await sql`SELECT current_period_end FROM subscriptions WHERE user_id = ${userId}`;
  const curEnd = sub[0] && sub[0].current_period_end ? new Date(sub[0].current_period_end).getTime() : 0;
  const base = curEnd > now ? curEnd : now;
  const periodEnd = new Date(base + PERIOD_MS).toISOString();
  await sql`UPDATE subscriptions SET status = 'active', current_period_end = ${periodEnd}, updated_at = now() WHERE user_id = ${userId}`;
  return true;
}
