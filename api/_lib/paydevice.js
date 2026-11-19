// Pago automatico desde el telefono (app Android KS Pagos).
// El telefono se vincula con un codigo de 6 digitos y queda con un token propio
// (aca solo su hash). Pide la siguiente orden por pagar, maneja la app de BDV y
// reporta cada etapa. Reglas que no dependen del telefono:
// - una orden se entrega UNA vez (claim atomico) y, desde que el telefono avisa que
//   va a confirmar, jamas se reintenta: si algo falla queda para revision manual;
// - antes de entregarla se reconsulta a Binance que siga sin pagar y con tiempo;
// - en la pantalla de confirmacion de BDV el servidor valida monto, cuenta destino
//   y que el titular coincida con el nombre verificado del vendedor;
// - el comprobante solo se acepta si su monto y destino coinciden con la orden.
import crypto from 'node:crypto';
import { sql, ensureP2pPay } from './db.js';
import { decrypt } from './crypto.js';
import { getOrderDetail, chatSend, chatText, chatImage, chatDelivered, chatUploadImage, markOrderPaid, holderMatches, fillTpl, PAY_TPL } from './binance.js';
import { sendPush } from './push.js';

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');
// Monto en centimos a partir de "370.000,00 Bs" o de un numero.
export const cents = v => (typeof v === 'number' ? Math.round(v * 100) : parseInt(digits(v) || '0', 10));

// Pantalla "Confirmar Operación" de BDV contra la orden: null = todo coincide.
// El titular es obligatorio: sin nombre que comparar, no se confirma solo.
export function confirmProblem(info, seen) {
  if (cents(seen.amount) !== cents(info.amount)) return 'el monto en BDV no coincide';
  if (!digits(seen.dest) || digits(seen.dest).slice(-4) !== digits(info.account).slice(-4)) return 'la cuenta destino en BDV no coincide';
  if (holderMatches(seen.name, info.sellerName) !== true) return 'el titular en BDV (' + (seen.name || '?') + ') no es el vendedor verificado';
  return null;
}

export async function newPairCode(uid) {
  await ensureP2pPay();
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await sql`DELETE FROM pay_pair WHERE user_id = ${uid} OR expires_at < now()`;
  await sql`INSERT INTO pay_pair (code_hash, user_id, expires_at) VALUES (${sha(code)}, ${uid}, now() + interval '10 minutes')`;
  return code;
}

async function creds(uid) {
  const cr = await sql`SELECT enc_key, iv_key, tag_key, enc_secret, iv_secret, tag_secret FROM binance_creds WHERE user_id = ${uid}`;
  if (!cr.length) return null;
  return {
    key: decrypt({ ct: cr[0].enc_key, iv: cr[0].iv_key, tag: cr[0].tag_key }),
    secret: decrypt({ ct: cr[0].enc_secret, iv: cr[0].iv_secret, tag: cr[0].tag_secret }),
  };
}
async function payCfg(uid) {
  const st = await sql`SELECT config FROM bot_state WHERE user_id = ${uid}`;
  const c = (st[0] && st[0].config) || {};
  return { mode: ['dry', 'auto'].includes(c.payAuto) ? c.payAuto : 'off', tpl: { ...PAY_TPL, ...(c.payTpl || {}) } };
}
async function setStatus(no, status, devPatch) {
  await sql`UPDATE p2p_pay SET status = ${status}, updated_at = now(),
    dev = COALESCE(dev, '{}'::jsonb) || ${JSON.stringify(devPatch || {})}::jsonb WHERE order_no = ${no}`;
}

// Devuelve { status, body } para responder.
export async function deviceRoute(req, path, params) {
  await ensureP2pPay();
  if (path === '/dev-pair') {
    const code = digits(params && params.code);
    const rows = await sql`DELETE FROM pay_pair WHERE code_hash = ${sha(code)} AND expires_at > now() RETURNING user_id`;
    if (!rows.length) return { status: 400, body: { error: 'Código inválido o vencido' } };
    const token = crypto.randomBytes(32).toString('hex');
    await sql`INSERT INTO pay_devices (token_hash, user_id, name, last_seen) VALUES (${sha(token)}, ${rows[0].user_id}, ${String((params && params.name) || 'Android').slice(0, 60)}, now())`;
    return { status: 200, body: { ok: true, token } };
  }
  const tok = String(req.headers['x-device-token'] || '');
  const dv = tok ? await sql`UPDATE pay_devices SET last_seen = now() WHERE token_hash = ${sha(tok)} RETURNING user_id` : [];
  if (!dv.length) return { status: 401, body: { error: 'Teléfono no vinculado' } };
  const uid = dv[0].user_id;
  const cfg = await payCfg(uid);

  if (path === '/dev-next') {
    if (cfg.mode === 'off') return { status: 200, body: { mode: 'off', job: null } };
    // Una orden a la vez: si hay una en curso en el telefono, se la devuelve (reanudar).
    const busy = await sql`SELECT order_no, status, info FROM p2p_pay WHERE user_id = ${uid}
      AND status IN ('paying', 'filled', 'confirmed') AND claimed_at > now() - interval '30 minutes' ORDER BY claimed_at LIMIT 1`;
    if (busy.length) return { status: 200, body: { mode: cfg.mode, job: job(busy[0]), resume: busy[0].status } };
    const cand = await sql`SELECT order_no, status, info FROM p2p_pay WHERE user_id = ${uid}
      AND status IN ('greeted', 'processing') AND created_at > now() - interval '2 hours' ORDER BY created_at LIMIT 1`;
    if (!cand.length) return { status: 200, body: { mode: cfg.mode, job: null } };
    const r = cand[0], info = r.info || {};
    const c = await creds(uid);
    if (!c) return { status: 200, body: { mode: cfg.mode, job: null, error: 'Sin llaves de Binance' } };
    // Reconsulta: sigue sin pagar, con al menos 2 min de plazo, y hay cuenta y titular.
    const det = await getOrderDetail(c.key, c.secret, r.order_no);
    const d = det.data || {};
    const why = !det.ok ? 'no pude leer la orden en Binance'
      : Number(d.orderStatus) !== 1 ? 'la orden ya no está pendiente de pago'
      : d.notifyPayEndTime && Number(d.notifyPayEndTime) - Date.now() < 120000 ? 'queda muy poco tiempo para pagar'
      : !info.account ? 'la orden no trae número de cuenta'
      : info.match === false ? 'el titular de la cuenta no coincide con el vendedor' : null;
    if (why) {
      await setStatus(r.order_no, 'manual', { reason: why });
      await sendPush(uid, '✋ Pago manual', 'Orden …' + r.order_no.slice(-4) + ': ' + why).catch(() => {});
      return { status: 200, body: { mode: cfg.mode, job: null, skipped: why } };
    }
    const cl = await sql`UPDATE p2p_pay SET status = 'paying', claimed_at = now(), updated_at = now()
      WHERE order_no = ${r.order_no} AND status IN ('greeted', 'processing') RETURNING order_no`;
    if (!cl.length) return { status: 200, body: { mode: cfg.mode, job: null } };
    if (r.status === 'greeted') chatSend(c.key, c.secret, [chatText(r.order_no, cfg.tpl.processing)]).catch(() => {});
    return { status: 200, body: { mode: cfg.mode, job: job(r) } };
  }

  const no = String((params && params.orderNo) || '');
  const rows = await sql`SELECT status, info, dev FROM p2p_pay WHERE order_no = ${no} AND user_id = ${uid}`;
  if (!rows.length) return { status: 404, body: { error: 'Orden no encontrada' } };
  const row = rows[0], info = row.info || {};

  if (path === '/dev-report') {
    const step = String(params.step || '');
    if (step === 'confirm_seen') {
      // Lo que BDV muestra antes de confirmar, contra la orden.
      const reason = confirmProblem(info, params);
      await sql`UPDATE p2p_pay SET dev = COALESCE(dev, '{}'::jsonb) || ${JSON.stringify({ seen: { name: params.name, amount: params.amount, dest: params.dest } })}::jsonb WHERE order_no = ${no}`;
      if (reason) {
        await setStatus(no, 'manual', { reason });
        await sendPush(uid, '✋ Pago detenido', 'Orden …' + no.slice(-4) + ': ' + reason).catch(() => {});
      }
      return { status: 200, body: { go: !reason, reason } };
    }
    if (step === 'filled') {
      // Ensayo: todo listo en BDV, falta que la persona confirme.
      await setStatus(no, 'filled', {});
      await sendPush(uid, '🧪 Listo para confirmar', 'Orden …' + no.slice(-4) + ': revisa y confirma en BDV').catch(() => {});
      return { status: 200, body: { ok: true } };
    }
    if (step === 'confirming') {
      // Punto sin retorno: solo se confirma si esto quedo grabado.
      if (row.status !== 'paying') return { status: 409, body: { error: 'estado ' + row.status } };
      await setStatus(no, 'confirmed', { confirmingAt: Date.now() });
      return { status: 200, body: { ok: true } };
    }
    if (step === 'failed') {
      const reason = String(params.reason || 'error').slice(0, 200);
      const after = row.status === 'confirmed';
      await setStatus(no, 'manual', { reason, stage: params.stage || null });
      await sendPush(uid, after ? '⚠ Revisa BDV' : '✋ Pago manual',
        'Orden …' + no.slice(-4) + ': ' + reason + (after ? '. Se tocó Confirmar: verifica en BDV si el pago salió antes de pagar de nuevo.' : '')).catch(() => {});
      return { status: 200, body: { ok: true } };
    }
    return { status: 400, body: { error: 'paso desconocido' } };
  }

  if (path === '/dev-receipt') {
    if (row.status === 'paid') return { status: 200, body: { ok: true, already: true } };
    if (!['paying', 'filled', 'confirmed'].includes(row.status)) return { status: 409, body: { error: 'estado ' + row.status } };
    if (cents(params.amount) !== cents(info.amount) || digits(params.dest).slice(-4) !== digits(info.account).slice(-4)) {
      await setStatus(no, 'manual', { reason: 'el comprobante no coincide con la orden' });
      return { status: 409, body: { error: 'el comprobante no coincide con la orden' } };
    }
    const c = await creds(uid);
    if (!c) return { status: 400, body: { error: 'Sin llaves de Binance' } };
    const b64 = String(params.image || '').replace(/^data:image\/\w+;base64,/, '');
    const steps = {};
    if (b64.length > 1000) {
      const up = await chatUploadImage(c.key, c.secret, Buffer.from(b64, 'base64'), `comprobante_${no.slice(-6)}.jpg`);
      steps.upload = up.ok ? 'ok' : up.msg;
      const msgs = [];
      if (up.ok) msgs.push(chatImage(no, up.imageUrl, Number(params.w) || 500, Number(params.h) || 500));
      msgs.push(chatText(no, cfg.tpl.paid + (params.ref ? ' Ref: ' + digits(params.ref) : '')));
      const sent = await chatSend(c.key, c.secret, msgs);
      steps.chat = sent.ok ? 'ok' : sent.msg;
      if (sent.ok) steps.delivered = await chatDelivered(c.key, c.secret, no, msgs.map(m => m.uuid)).catch(() => null);
    }
    const mk = await markOrderPaid(c.key, c.secret, no, info.payId);
    steps.markPaid = mk.ok ? 'ok' : ((mk.code || mk.status) + ' ' + (mk.msg || ''));
    if (!mk.ok) {
      await setStatus(no, 'manual', { reason: 'pagado en BDV pero Binance no la marcó: ' + steps.markPaid, ref: params.ref || null });
      await sendPush(uid, '⚠ Marca la orden pagada', 'Orden …' + no.slice(-4) + ': el pago salió en BDV pero Binance no la marcó').catch(() => {});
      return { status: 502, body: { error: steps.markPaid, steps } };
    }
    await setStatus(no, 'paid', { ref: params.ref || null, paidAt: Date.now(), steps });
    return { status: 200, body: { ok: true, steps } };
  }
  return { status: 404, body: { error: 'Ruta desconocida' } };
}

function job(r) {
  const i = r.info || {};
  return { orderNo: r.order_no, account: i.account, amount: i.amount, cents: cents(i.amount),
           sellerName: i.sellerName, holder: i.holder, concept: r.order_no, payEnd: i.payEnd || null }; // concepto = numero de orden
}
