// Avisos de vencimiento. En cripto no hay debito automatico: si nadie le recuerda
// al cliente que renueve, se le apaga el bot en medio de una operacion y se va.
// Este barrido es lo que convierte un cobro manual en una suscripcion.
//
// Corre pegado al tick del bot (que ya se dispara solo desde el scheduler), con su
// propio throttle: no hace falta otra funcion serverless — en Hobby no sobran.
import { sql, ensurePayState, ensureRenewColumn } from './db.js';
import { adminUserId, GRACE_MS } from './subscriptions.js';
import { sendTelegram, resolveTelegram } from './telegram.js';
import { sendPush, stripHtml } from './push.js';
import { appUrl } from './mail.js';

const DAY_MS = 24 * 3600 * 1000;
const SWEEP_THROTTLE_MS = 60 * 60 * 1000;   // el barrido, 1 vez por hora
const USER_THROTTLE_MS = 20 * 60 * 60 * 1000; // a cada persona, 1 aviso por dia
const WARN_AHEAD_MS = 3 * DAY_MS;           // desde cuando se empieza a avisar
const MAX_PER_SWEEP = 200;

function dias(ms) {
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

// Que decirle a cada quien segun cuanto le queda. msLeft negativo = ya vencio.
export function renewalMessage(status, msLeft, url) {
  const link = '\n\n' + url;
  if (status === 'trialing') {
    if (msLeft > 0) {
      const d = dias(msLeft);
      return {
        tg: '<b>⏳ Tu prueba gratis termina en ' + d + (d === 1 ? ' dia' : ' dias') + '</b>\n' +
            'Suscribete para que el monitor y el bot sigan trabajando sin cortes.' + link,
        title: '⏳ Tu prueba termina en ' + d + (d === 1 ? ' dia' : ' dias'),
      };
    }
    return {
      tg: '<b>🔒 Se acabo tu prueba gratis</b>\n' +
          'El monitor y el bot quedaron en pausa. Se reactivan apenas te suscribas.' + link,
      title: '🔒 Se acabo tu prueba gratis',
    };
  }
  if (msLeft > 0) {
    const d = dias(msLeft);
    return {
      tg: '<b>🔔 Tu suscripcion vence en ' + d + (d === 1 ? ' dia' : ' dias') + '</b>\n' +
          'Renuevala desde la app para no perder el monitor ni el bot.' + link,
      title: '🔔 Tu suscripcion vence en ' + d + (d === 1 ? ' dia' : ' dias'),
    };
  }
  if (msLeft > -GRACE_MS) {
    const d = dias(GRACE_MS + msLeft);
    return {
      tg: '<b>⚠️ Tu suscripcion vencio</b>\n' +
          'Te dejamos ' + d + (d === 1 ? ' dia' : ' dias') + ' de cortesia: todo sigue funcionando ' +
          'mientras tanto. Renueva para no quedarte sin el bot.' + link,
      title: '⚠️ Tu suscripcion vencio',
    };
  }
  return {
    tg: '<b>🔒 Acceso suspendido</b>\n' +
        'Se acabo la cortesia y el monitor y el bot quedaron en pausa. Se reactivan ' +
        'apenas renueves.' + link,
    title: '🔒 Acceso suspendido',
  };
}

async function shouldSweep() {
  const rows = await sql`SELECT renew_checked_at FROM email_payment_state WHERE id = 1`;
  const last = rows[0] && rows[0].renew_checked_at ? new Date(rows[0].renew_checked_at).getTime() : 0;
  return Date.now() - last >= SWEEP_THROTTLE_MS;
}

export async function sweepRenewals(force) {
  await ensurePayState();
  if (!force && !(await shouldSweep())) return { skipped: 'throttled' };
  await ensureRenewColumn();

  const now = Date.now();
  // Ventana: desde 3 dias antes de vencer hasta 2 dias despues de agotada la
  // cortesia. Pasado eso se deja de insistir — quien no volvio, no volvio.
  const lo = new Date(now - GRACE_MS - 2 * DAY_MS).toISOString();
  const hi = new Date(now + WARN_AHEAD_MS).toISOString();
  const throttle = new Date(now - USER_THROTTLE_MS).toISOString();
  const adminId = await adminUserId();

  const rows = await sql`
    SELECT user_id, status, trial_end, current_period_end
    FROM subscriptions
    WHERE user_id <> ${adminId}
      AND (renew_notified_at IS NULL OR renew_notified_at < ${throttle})
      AND ((status = 'active'   AND current_period_end BETWEEN ${lo} AND ${hi})
        OR (status = 'trialing' AND trial_end          BETWEEN ${lo} AND ${hi}))
    ORDER BY user_id
    LIMIT ${MAX_PER_SWEEP}`;

  const url = appUrl() + '/p2p-monitor/';
  let sent = 0;
  for (const r of rows) {
    const end = r.status === 'trialing' ? r.trial_end : r.current_period_end;
    if (!end) continue;
    const msg = renewalMessage(r.status, new Date(end).getTime() - now, url);
    const { token, chatId } = await resolveTelegram(r.user_id);
    if (token && chatId) { try { await sendTelegram(token, chatId, msg.tg); } catch (e) {} }
    await sendPush(r.user_id, msg.title, stripHtml(msg.tg).split('\n').slice(1).join('\n').trim()).catch(() => {});
    await sql`UPDATE subscriptions SET renew_notified_at = now() WHERE user_id = ${r.user_id}`;
    sent++;
  }

  await sql`UPDATE email_payment_state SET renew_checked_at = now() WHERE id = 1`;
  return { candidates: rows.length, sent };
}
