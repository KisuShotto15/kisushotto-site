// Ejecutor server-side del bot. Lo dispara el Durable Object de Cloudflare cada ~18s.
// Protegido por secreto compartido (x-bot-secret). NO usa JWT.
import { sql } from './_lib/db.js';
import { decrypt } from './_lib/crypto.js';
import { getMyAds, updateAdPrice, updateMinLimit, publicSearch, setAdStatus, listOrders } from './_lib/binance.js';
import { computeReprice, adPayTypes } from './_lib/reprice.js';
import { computeAlerts, topMedianRate, pushHist24Pay, pushHistLongPay, pushOhlcPay, histMap, histPaySnapshot, histPayChanged } from './_lib/monitor.js';
import { sendTelegram } from './_lib/telegram.js';
import { sendPush, stripHtml } from './_lib/push.js';

export const config = { maxDuration: 60 };

const MAX_USERS = 25; // tope por tick (secuencial)

function pushLog(log, msg, level) {
  const arr = Array.isArray(log) ? log.slice(-19) : [];
  arr.push({ ts: Date.now(), msg, level: level || 'info' });
  return arr;
}

// ── Horario (America/Caracas, UTC-4 fijo) ──────────────
function caracasMinutes(now) {
  const d = new Date(now - 4 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function hmToMin(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function inQuietHours(start, end, now) {
  if (!start || !end) return false;
  const s = hmToMin(start), e = hmToMin(end), cur = caracasMinutes(now);
  if (s === e) return false;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e); // soporta franja nocturna
}
function caracasDateStr(now) {
  return new Date(now - 4 * 3600 * 1000).toISOString().slice(0, 10);
}
function caracasHm(now) {
  const d = new Date(now - 4 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
// Resumen una vez al dia: ya paso la hora y no se mando hoy (zona Caracas).
function shouldSendSummary(hour, lastSummary, now) {
  if (!hour) return false;
  if (caracasMinutes(now) < hmToMin(hour)) return false;
  if (!lastSummary) return true;
  return caracasDateStr(new Date(lastSummary).getTime()) !== caracasDateStr(now);
}
function buildSummary(hist, now) {
  const pts = (hist || []).filter(p => p && p.price && now - p.ts <= 24 * 3600 * 1000);
  if (pts.length < 2) return '<b>📊 Resumen P2P · últimas 24h</b>\nSin datos suficientes todavía.';
  let max = pts[0], min = pts[0];
  for (const p of pts) { if (p.price > max.price) max = p; if (p.price < min.price) min = p; }
  const open = pts[0].price, close = pts[pts.length - 1].price;
  const chg = (close - open) / open * 100;
  return '<b>📊 Resumen P2P · últimas 24h</b>\n' +
    '🔼 Máx: ' + max.price.toFixed(2) + ' Bs (' + caracasHm(max.ts) + ')\n' +
    '🔽 Mín: ' + min.price.toFixed(2) + ' Bs (' + caracasHm(min.ts) + ')\n' +
    'Apertura → cierre: ' + open.toFixed(2) + ' → ' + close.toFixed(2) + ' Bs (' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%)\n' +
    'Rango: ' + (max.price - min.price).toFixed(2) + ' Bs';
}

async function tickMonitor(row, now) {
  const cfg = row.config || {};

  // Si la app esta abierta y refrescando (latido fresco), el cliente cubre el monitor:
  // el servidor no busca ni alerta (evita duplicar requests a Binance y mensajes Telegram).
  const seenMs = row.client_seen ? now - new Date(row.client_seen).getTime() : Infinity;
  if (seenMs < 70 * 1000) return null;

  const silent = inQuietHours(cfg.quietStart, cfg.quietEnd, now);
  const refreshSec = silent ? (cfg.quietRefreshSec || 180) : (cfg.refreshSec || 30);

  // Respetar la cadencia (el tick base es ~18s; aqui decidimos si toca refrescar).
  if (row.last_tick && (now - new Date(row.last_tick).getTime()) < refreshSec * 1000) return null;

  // Claim atomico: si otro tick concurrente ya refresco a este usuario, saltar
  // (evita doble busqueda y doble alerta Telegram).
  const claim = await sql`
    UPDATE monitor_state SET last_tick = now()
    WHERE user_id = ${row.user_id} AND enabled = true
      AND (last_tick IS NULL OR last_tick < now() - interval '25 seconds')
    RETURNING user_id`;
  if (!claim.length) return null;

  // Columnas pesadas (hist_long/hist_ohlc crecen sin limite) SOLO cuando toca refrescar:
  // parsearlas en cada tick de 18s era CPU desperdiciada.
  const hrows = await sql`
    SELECT price_hist, cooldowns, hist24, hist_long, hist_ohlc, last_summary, log
    FROM monitor_state WHERE user_id = ${row.user_id}`;
  const h = hrows[0] || {};

  const pays = (cfg.payTypes && cfg.payTypes.length) ? cfg.payTypes : [];
  const verifiedOnly = cfg.verifiedOnly !== false;
  const mayRaw = await publicSearch({ transAmount: cfg.mayAmount || 2000000, pays, maxPages: 2, tradeType: 'SELL', verifiedOnly });
  const smallRaw = await publicSearch({ transAmount: cfg.smallAmount || 59999, pays, maxPages: 3, tradeType: 'SELL', verifiedOnly });

  const out = computeAlerts({ mayRaw, smallRaw, cfg, priceHist: h.price_hist, cooldowns: h.cooldowns, now, silent });
  const pay = pays[0] || 'BancoDeVenezuela';
  // Tasa USDT/VES publica (mediana top-10 mayoristas): la consume el portfolio.
  // Best-effort: un fallo aqui no debe tumbar el tick del monitor.
  const med = topMedianRate(mayRaw, 10, verifiedOnly);
  if (med) {
    await sql`INSERT INTO p2p_rate (pay, rate, n, updated_at) VALUES (${pay}, ${med.rate}, ${med.n}, now())
      ON CONFLICT (pay) DO UPDATE SET rate = excluded.rate, n = excluded.n, updated_at = now()`.catch(() => {});
  }
  const snap24 = histPaySnapshot(h.hist24, pay);
  const snapLong = histPaySnapshot(h.hist_long, pay);
  const hist24 = pushHist24Pay(h.hist24, pay, now, out.bestMay);
  const histLong = pushHistLongPay(h.hist_long, pay, now, out.bestMay);
  const histOhlc = pushOhlcPay(h.hist_ohlc, pay, now, out.bestMay);

  let log = h.log;
  let token = '';
  try { token = (cfg.tg && cfg.tg.token_enc) ? decrypt(cfg.tg.token_enc) : ''; } catch (e) {}
  const chatId = cfg.tg && cfg.tg.chatId;

  if (!silent && out.alerts.length) {
    for (const a of out.alerts) {
      if (token && chatId) await sendTelegram(token, chatId, '<b>🟡 P2P — ' + a.title + '</b>\n' + a.desc);
      await sendPush(row.user_id, '🟡 P2P — ' + stripHtml(a.title), stripHtml(a.desc)).catch(() => {});
    }
    log = pushLog(log, '📩 ' + out.alerts.length + ' alerta(s) notificada(s)', 'info');
  }

  // Resumen diario (no depende del silencio nocturno; se manda a la hora configurada)
  let lastSummary = h.last_summary;
  if (shouldSendSummary(cfg.summaryHour, lastSummary, now)) {
    const summary = buildSummary(histMap(hist24)[pay], now);
    if (token && chatId) await sendTelegram(token, chatId, summary);
    await sendPush(row.user_id, '📊 Resumen P2P · últimas 24h', stripHtml(summary).split('\n').slice(1).join('\n')).catch(() => {});
    lastSummary = new Date(now).toISOString();
    log = pushLog(log, '📊 Resumen diario → Telegram', 'info');
  }

  return {
    priceHist: out.priceHist,
    cooldowns: out.cooldowns,
    hist24,
    histLong,
    histOhlc,
    lastSummary,
    log,
    // Solo re-serializar/escribir las series que realmente cambiaron (hist_long solo
    // suma 1 punto cada 30 min; stringify de anios de datos cada 30s era CPU pura).
    hist24Changed: histPayChanged(snap24, hist24, pay),
    histLongChanged: histPayChanged(snapLong, histLong, pay),
    ohlcChanged: !!out.bestMay,
    status: silent ? '🌙 Silencio nocturno' : (out.bestMay ? '🟢 Vigilando ' + out.bestMay.toFixed(2) + ' Bs' : '🟢 Vigilando'),
  };
}

function pickAd(ads, adNo) {
  if (adNo) {
    return ads.find(a => String(a.adNumber || a.advNo) === String(adNo)) || null;
  }
  return ads.find(a => {
    const isBuy  = a.tradeType === 'BUY';
    const isUsdt = a.asset === 'USDT' || a.cryptoCurrency === 'USDT';
    const isVes  = a.fiatUnit === 'VES' || a.fiatCurrency === 'VES' || a.fiat === 'VES';
    const isLive = a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1 || a.adStatus === 1;
    return isBuy && isUsdt && isVes && isLive;
  }) || null;
}

async function tickUser(row) {
  const cfg = row.config || {};
  let log = row.log;
  let status = '';
  let adNumber = row.ad_number;
  let currentPrice = row.current_price;
  let lastReprice = row.last_reprice;

  const key = decrypt({ ct: row.enc_key, iv: row.iv_key, tag: row.tag_key });
  const secret = decrypt({ ct: row.enc_secret, iv: row.iv_secret, tag: row.tag_secret });

  const my = await getMyAds(key, secret);
  if (!my.ok || !my.ads.length) {
    status = 'Sin anuncios';
    log = pushLog(log, 'Sin anuncios o API sin permiso', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice };
  }

  const ad = pickAd(my.ads, cfg.adNo);
  if (!ad) {
    status = 'Anuncio no encontrado';
    log = pushLog(log, 'Anuncio configurado no encontrado', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice };
  }

  const surplus = parseFloat(ad.surplusAmount || ad.tradableQuantity || ad.remainQuantity || 0);
  if (surplus > 0 && surplus < 100) {
    // Pausar el anuncio en Binance: que no quede vivo y mal posicionado al apagarse el bot.
    const adNo = String(ad.advNo || ad.adNumber);
    const off = await setAdStatus(key, secret, adNo, 3).catch(() => ({ ok: false }));
    log = pushLog(log, off.ok ? '🛑 Fondos insuficientes (<100 USDT) — anuncio pausado y bot detenido'
                              : '🛑 Fondos insuficientes — bot detenido (no se pudo pausar el anuncio)', 'error');
    return { enabled: false, status: 'Detenido: fondos bajos', log, adNumber: adNo, currentPrice, lastReprice };
  }

  if (!cfg.sellPrice) {
    status = 'Falta precio de venta';
    log = pushLog(log, 'Configura el precio de venta', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice };
  }

  adNumber = String(ad.advNo || ad.adNumber);
  const myMin = parseFloat(ad.minSingleTransAmount);
  const threshold = cfg.limitThreshold || 0;
  const pays = adPayTypes(ad).length ? adPayTypes(ad) : (cfg.payTypes && cfg.payTypes.length ? cfg.payTypes : []);

  // Ajustar limite minimo si cambio
  if (cfg.minLimit > 0 && cfg.minLimit !== myMin) {
    const u = await updateMinLimit(key, secret, adNumber, cfg.minLimit);
    if (u.ok && (!u.data.code || u.data.code === '000000')) {
      log = pushLog(log, '📏 Límite mínimo → ' + cfg.minLimit + ' VES', 'info');
    } else {
      log = pushLog(log, 'Límite [' + (u.data.code || '?') + ']: ' + (u.data.message || ''), 'warn');
    }
  }

  const marketRaw = await publicSearch({ transAmount: myMin + threshold, pays, maxPages: 2, tradeType: 'SELL', verifiedOnly: cfg.verifiedOnly !== false });
  const res = computeReprice({ ad, marketRaw, cfg });

  if (res.targetPrice === null) {
    status = res.reason;
    currentPrice = res.currentPrice;
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice };
  }

  const up = await updateAdPrice(key, secret, adNumber, Number(res.targetPrice.toFixed(3)));
  if (up.ok && (!up.data.code || up.data.code === '000000')) {
    const isUp = res.targetPrice > res.currentPrice;
    log = pushLog(log, (isUp ? '↑' : '↓') + ' ' + res.currentPrice.toFixed(3) + ' → ' + res.targetPrice.toFixed(3) + ' Bs | ' + res.reason, isUp ? 'up' : 'down');
    currentPrice = res.targetPrice;
    lastReprice = new Date().toISOString();
    status = '✓ Repreciado';
  } else {
    const msg = up.data.message || (String(up.data.code) === '-1002'
      ? 'API key no autorizada para editar anuncios' : ('código ' + up.data.code));
    log = pushLog(log, 'Update [' + (up.data.code || up.data) + ']: ' + msg, 'error');
    status = 'Error al actualizar';
    currentPrice = res.currentPrice;
  }
  return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice };
}

// Notifica por Telegram las ordenes nuevas del usuario (24/7, app cerrada). Throttle ~60s.
// Primera vez: siembra known_orders sin notificar. Devuelve { known, checkedAt, log } o null.
async function maybeCheckOrders(row, now) {
  if (row.orders_checked_at && now - new Date(row.orders_checked_at).getTime() < 60 * 1000) return null;
  const cfg = row.config || {};
  const key = decrypt({ ct: row.enc_key, iv: row.iv_key, tag: row.tag_key });
  const secret = decrypt({ ct: row.enc_secret, iv: row.iv_secret, tag: row.tag_secret });
  const { ok, orders, raw } = await listOrders(key, secret, 2 * 3600 * 1000);
  const checkedAt = new Date(now).toISOString();
  let log = row.log;
  if (!ok) {
    log = pushLog(log, '⚠ Órdenes: API falló [' + ((raw && raw.code) || '?') + '] ' + ((raw && raw.message) || (raw ? JSON.stringify(raw).slice(0, 120) : '')), 'warn');
    return { known: row.known_orders, checkedAt, log };
  }

  const ids = orders.map(o => String(o.orderNumber));
  const prev = Array.isArray(row.known_orders) ? row.known_orders : null;
  if (prev === null) {
    log = pushLog(log, '🔎 Órdenes: ' + orders.length + ' en historial 2h (sembrado inicial, sin avisar)', 'info');
    return { known: ids.slice(0, 50), checkedAt, log };
  }

  const knownSet = new Set(prev);
  const fresh = orders.filter(o => !knownSet.has(String(o.orderNumber)));
  const newKnown = Array.from(new Set([...ids, ...prev])).slice(0, 50);
  if (fresh.length) {
    let token = '';
    try { token = (cfg.tg && cfg.tg.token_enc) ? decrypt(cfg.tg.token_enc) : ''; } catch (e) {}
    const chatId = cfg.tg && cfg.tg.chatId;
    const f = fresh[0];
    // El historial de ordenes trae unitPrice (no price); si falta, derivar de total/cantidad.
    const amt = parseFloat(f.amount || 0);
    const total = parseFloat(f.totalPrice || 0) || (amt * parseFloat(f.unitPrice || f.price || 0));
    const price = parseFloat(f.unitPrice || f.price || 0) || (amt > 0 && total > 0 ? total / amt : 0);
    if (token && chatId) {
      let msg = '🟢 <b>Nueva orden P2P</b>\nCantidad: ' + (amt ? amt.toFixed(2) : '?') + ' USDT' +
        '\nTotal: ' + (total ? total.toFixed(2) : '?') + ' Bs' +
        '\nPrecio: ' + (price ? price.toFixed(3) : '?') + ' Bs';
      if (fresh.length > 1) msg += '\n(+' + (fresh.length - 1) + ' más)';
      const sent = await sendTelegram(token, chatId, msg);
      log = pushLog(log, sent ? '📩 ' + fresh.length + ' orden(es) nueva(s) → Telegram'
                               : '⚠ Orden nueva pero Telegram rechazó el envío', sent ? 'info' : 'warn');
    } else {
      log = pushLog(log, '⚠ ' + fresh.length + ' orden(es) nueva(s) pero el bot no tiene Telegram configurado', 'warn');
    }
    await sendPush(row.user_id, '🟢 Nueva orden P2P',
      'Cantidad: ' + (amt ? amt.toFixed(2) : '?') + ' USDT · Total: ' + (total ? total.toFixed(2) : '?') + ' Bs · Precio: ' + (price ? price.toFixed(3) : '?') + ' Bs' +
      (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ' más)' : '')).catch(() => {});
  }
  return { known: newKnown, checkedAt, log };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.BOT_TICK_SECRET || req.headers['x-bot-secret'] !== process.env.BOT_TICK_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    // Sin ensureSchema(): el schema ya existe (lo crean los endpoints de auth/app).
    // Correr ~25 DDLs por cold start cada 18s era costo inutil.
    const rows = await sql`
      SELECT b.user_id, b.enabled, b.config, b.ad_number, b.current_price, b.last_reprice, b.log,
             b.known_orders, b.orders_checked_at,
             c.enc_key, c.iv_key, c.tag_key, c.enc_secret, c.iv_secret, c.tag_secret
      FROM bot_state b
      JOIN binance_creds c ON c.user_id = b.user_id
      WHERE b.enabled = true
      LIMIT ${MAX_USERS}`;

    let ticked = 0;
    for (const row of rows) {
      // Claim atomico: evita que dos ticks solapados (DO ~18s + latencia Binance)
      // repricien al mismo usuario en paralelo.
      const claim = await sql`
        UPDATE bot_state SET last_tick = now()
        WHERE user_id = ${row.user_id} AND enabled = true
          AND (last_tick IS NULL OR last_tick < now() - interval '12 seconds')
        RETURNING user_id`;
      if (!claim.length) continue;
      let out;
      try {
        out = await tickUser(row);
      } catch (e) {
        out = { enabled: row.enabled, status: 'Error: ' + e.message, log: pushLog(row.log, 'Error: ' + e.message, 'error'),
                adNumber: row.ad_number, currentPrice: row.current_price, lastReprice: row.last_reprice };
      }
      // Notificacion de ordenes nuevas (independiente del reprice; usa el log ya actualizado).
      let knownOrders = row.known_orders, ordersCheckedAt = row.orders_checked_at;
      if (out.enabled) {
        try {
          const oc = await maybeCheckOrders({ ...row, log: out.log }, Date.now());
          if (oc) { knownOrders = oc.known; ordersCheckedAt = oc.checkedAt; if (oc.log) out.log = oc.log; }
        } catch (e) {}
      }
      // enabled = enabled AND out.enabled: el tick solo puede APAGAR, nunca re-encender.
      // Si el usuario pulso Detener mientras este tick corria, no resucitar el bot.
      await sql`
        UPDATE bot_state SET
          enabled = enabled AND ${out.enabled},
          status = ${out.status || null},
          log = ${JSON.stringify(out.log || [])}::jsonb,
          ad_number = ${out.adNumber || null},
          current_price = ${out.currentPrice != null ? out.currentPrice : null},
          last_reprice = ${out.lastReprice || null},
          known_orders = ${knownOrders != null ? JSON.stringify(knownOrders) : null}::jsonb,
          orders_checked_at = ${ordersCheckedAt || null},
          updated_at = now()
        WHERE user_id = ${row.user_id}`;
      // OJO: last_tick NO se re-sella aqui: lo marca el claim al INICIO del tick.
      // Sellarlo al final sumaba el tiempo de proceso y hacia saltar 1 de cada 2 ticks (~36s).
      ticked++;
    }

    // Monitor server-side (alertas Telegram 24/7 con silencio nocturno).
    // SELECT liviano: las columnas pesadas se leen dentro de tickMonitor solo si toca refrescar.
    const mrows = await sql`
      SELECT user_id, config, last_tick, client_seen
      FROM monitor_state WHERE enabled = true LIMIT ${MAX_USERS}`;
    let monitored = 0;
    for (const row of mrows) {
      let out;
      try {
        out = await tickMonitor(row, Date.now());
      } catch (e) {
        // Solo status: aqui no tenemos los historiales cargados y no hay que pisarlos.
        await sql`UPDATE monitor_state SET status = ${'Error: ' + e.message}, updated_at = now()
          WHERE user_id = ${row.user_id}`.catch(() => {});
        continue;
      }
      if (out === null) continue; // no toca refrescar aun
      await sql`
        UPDATE monitor_state SET
          price_hist = ${JSON.stringify(out.priceHist || [])}::jsonb,
          cooldowns = ${JSON.stringify(out.cooldowns || {})}::jsonb,
          hist24 = COALESCE(${out.hist24Changed ? JSON.stringify(out.hist24 || []) : null}::jsonb, hist24),
          hist_long = COALESCE(${out.histLongChanged ? JSON.stringify(out.histLong || []) : null}::jsonb, hist_long),
          hist_ohlc = COALESCE(${out.ohlcChanged ? JSON.stringify(out.histOhlc || {}) : null}::jsonb, hist_ohlc),
          last_summary = ${out.lastSummary || null},
          log = ${JSON.stringify(out.log || [])}::jsonb,
          status = ${out.status || null},
          updated_at = now()
        WHERE user_id = ${row.user_id}`;
      monitored++;
    }

    // bots/monitors: se los lee el scheduler de CF para adaptar la cadencia
    // (18s con bots, 30s solo-monitor, backoff si no hay nada habilitado).
    // nextSec: sin bots, cuando toca el proximo refresh de monitor (de noche
    // quietRefreshSec=180 → el scheduler duerme 180s en vez de 30s).
    let nextSec = null;
    if (!rows.length && mrows.length) {
      const tnow = Date.now();
      nextSec = Math.min(...mrows.map(r => {
        const cfg = r.config || {};
        const silent = inQuietHours(cfg.quietStart, cfg.quietEnd, tnow);
        const rs = silent ? (cfg.quietRefreshSec || 180) : (cfg.refreshSec || 30);
        const elapsed = r.last_tick ? (tnow - new Date(r.last_tick).getTime()) / 1000 : rs;
        const rem = rs - elapsed;
        return rem <= 0 ? rs : Math.max(rem, 5); // ya refresco en este tick → espera completa
      }));
    }
    return res.status(200).json({ ok: true, ticked, monitored, bots: rows.length, monitors: mrows.length, nextSec });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
