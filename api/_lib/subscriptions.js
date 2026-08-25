// Logica de suscripcion compartida entre la ruta HTTP (/api/payments) y el poller
// de Binance Pay (pay-poll.js), para no duplicar el criterio de "que significa pagar".
import { sql } from './db.js';

export const TRIAL_DAYS = 7;
export const SUB_CURRENCY = 'USDT';

const DAY_MS = 24 * 3600 * 1000;

// Cada plan tiene su propio Payment Link (monto fijo en Binance Pay: un solo link
// no puede cobrar dos montos distintos). PAYMENT_LINK_URL sin sufijo queda como
// alias de "monthly" para no romper la config que ya existia.
export const PLANS = {
  monthly: {
    price: process.env.SUB_PRICE_MONTHLY || '70',
    periodMs: 30 * DAY_MS,
    link: () => process.env.PAYMENT_LINK_URL_MONTHLY || process.env.PAYMENT_LINK_URL || null,
  },
  annual: {
    price: process.env.SUB_PRICE_ANNUAL || '700',
    periodMs: 365 * DAY_MS,
    link: () => process.env.PAYMENT_LINK_URL_ANNUAL || null,
  },
};

export async function ensureSubscription(userId) {
  const rows = await sql`SELECT * FROM subscriptions WHERE user_id = ${userId}`;
  if (rows.length) return rows[0];
  // Sin trial_end: la prueba NO arranca sola, el usuario la activa a mano (start-trial).
  await sql`INSERT INTO subscriptions (user_id, status) VALUES (${userId}, 'not_started') ON CONFLICT (user_id) DO NOTHING`;
  const out = await sql`SELECT * FROM subscriptions WHERE user_id = ${userId}`;
  return out[0];
}

// Activa la prueba gratis. Solo funciona una vez (desde 'not_started'); si ya se
// activo o vencio, devuelve null y el llamador decide como avisar.
export async function startTrial(userId) {
  const trialEnd = new Date(Date.now() + TRIAL_DAYS * DAY_MS).toISOString();
  const upd = await sql`
    UPDATE subscriptions SET status = 'trialing', trial_end = ${trialEnd}, updated_at = now()
    WHERE user_id = ${userId} AND status = 'not_started'
    RETURNING *`;
  return upd[0] || null;
}

// Suma 1 periodo (segun el plan de la factura) desde el vencimiento actual (si ya
// vencio, desde ahora) — evita que pagar temprano "regale" dias por encimarse con
// el periodo vigente.
export async function markPaid(invoiceId, userId, txId) {
  const upd = await sql`
    UPDATE payment_invoices SET status = 'paid', transaction_id = ${txId || null}, paid_at = now()
    WHERE id = ${invoiceId} AND status IN ('pending', 'pending_review')
    RETURNING plan`;
  if (!upd.length) return false; // ya estaba resuelta (evita doble conteo de periodo)
  const plan = PLANS[upd[0].plan] ? upd[0].plan : 'monthly';
  const now = Date.now();
  const sub = await sql`SELECT current_period_end FROM subscriptions WHERE user_id = ${userId}`;
  const curEnd = sub[0] && sub[0].current_period_end ? new Date(sub[0].current_period_end).getTime() : 0;
  const base = curEnd > now ? curEnd : now;
  const periodEnd = new Date(base + PLANS[plan].periodMs).toISOString();
  await sql`UPDATE subscriptions SET status = 'active', current_period_end = ${periodEnd}, updated_at = now() WHERE user_id = ${userId}`;
  return true;
}

// Id del admin, resuelto desde ADMIN_EMAIL. Memoizado: se usa en cada tick del bot
// para no dejar al dueño fuera de su propio producto (su fila de subscriptions
// puede estar en 'not_started' porque /status le devuelve la exencion sin tocarla).
let adminIdCache = null;
export async function adminUserId() {
  if (adminIdCache !== null) return adminIdCache;
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) { adminIdCache = 0; return 0; }
  try {
    const rows = await sql`SELECT id FROM users WHERE lower(email) = ${email}`;
    adminIdCache = (rows[0] && rows[0].id) || 0;
  } catch (e) {
    adminIdCache = 0;
  }
  return adminIdCache;
}

// Cache en memoria por instancia: /p2p-search se llama cada 15s por usuario y no
// puede pagar un round-trip a Postgres en cada refresco. 60s de desfase es el
// precio (gracia al vencer, o espera corta tras pagar).
const activeCache = new Map();
const ACTIVE_TTL_MS = 60 * 1000;

export async function hasActiveSub(userId) {
  const hit = activeCache.get(userId);
  if (hit && Date.now() - hit.at < ACTIVE_TTL_MS) return hit.ok;
  let ok;
  try {
    if (userId === await adminUserId()) {
      ok = true;
    } else {
      const rows = await sql`
        SELECT 1 FROM subscriptions
        WHERE user_id = ${userId}
          AND ((status = 'trialing' AND trial_end > now())
            OR (status = 'active' AND current_period_end > now()))`;
      ok = rows.length > 0;
    }
  } catch (e) {
    // Si la base falla, dejar pasar: cortarle el monitor a quien si pago es peor
    // que colarse un rato a quien no.
    ok = true;
  }
  activeCache.set(userId, { ok, at: Date.now() });
  return ok;
}

export function planInfo() {
  return {
    monthly: { price: PLANS.monthly.price, currency: SUB_CURRENCY, link: PLANS.monthly.link() },
    annual: { price: PLANS.annual.price, currency: SUB_CURRENCY, link: PLANS.annual.link() },
  };
}
