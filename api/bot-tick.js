// Ejecutor server-side del bot. Lo dispara el Durable Object de Cloudflare cada ~18s.
// Protegido por secreto compartido (x-bot-secret). NO usa JWT.
import { sql, ensureMarketHist } from './_lib/db.js';
import { decrypt } from './_lib/crypto.js';
import { getMyAds, updateAdPrice, updateMinLimit, publicSearch, setAdStatus, listOrders } from './_lib/binance.js';
import { computeReprice, adPayTypes, isAdHidden } from './_lib/reprice.js';
import { computeAlerts, topMedianRate, pushHist24Pay, pushHistLongPay, histMap, histPaySnapshot, histPayChanged, bestOf } from './_lib/monitor.js';
import { sendTelegram, resolveTelegram } from './_lib/telegram.js';
import { sendPush, stripHtml } from './_lib/push.js';
import { adminUserId, GRACE_MS } from './_lib/subscriptions.js';
import { sweepRenewals } from './_lib/renewals.js';

export const config = { maxDuration: 60 };

const MAX_USERS = 25; // tope por tick (secuencial)
const SAMPLE_MS = 5 * 60 * 1000; // cadencia del muestreo de estado del anuncio

// ── Serie global del grafico ───────────────────────────
// Es el mismo mercado para todos, asi que la curva es una sola y se mide SIEMPRE con
// los mismos parametros: el filtro de VES (cfg.mayAmount) y el toggle de verificados
// de cada usuario deformaban la serie, y al vivir en monitor_state un usuario nuevo
// abria la app con el grafico vacio. Corre aparte del tick por usuario, asi que
// tambien se alimenta cuando nadie tiene el monitor encendido.
const GLOBAL_PAY = 'BancoDeVenezuela';
// 0 = sin filtro de monto: la serie es el tope real del libro y no depende de lo que
// cada quien tenga puesto en Mayoristas. No hace falta filtrar por monto para limpiar
// ruido: mapBest ya descarta anuncios con menos de MIN_AVAIL (2000 USDT) y
// bestCorroborated exige un segundo anuncio cerca del precio, asi que un dedazo no entra.
// verifiedOnly SI se mantiene: es parte de la definicion del precio, no un filtro personal.
const GLOBAL_AMOUNT = 0;
const GLOBAL_SAMPLE_MS = 2 * 60 * 1000; // igual que la cadencia de pushHist24

// Siembra unica: la serie global arranca vacia, pero el historial del admin ya tiene
// meses de mercado (es el mismo mercado). Se copia una sola vez, fusionado con lo poco
// que la serie global haya acumulado, y queda marcada con seeded para no repetirse.
async function seedGlobalHist() {
  const rows = await sql`SELECT hist24, hist_long, seeded FROM market_hist WHERE pay = ${GLOBAL_PAY}`;
  if (rows.length && rows[0].seeded) return;
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail) return;
  const src = await sql`
    SELECT m.hist24, m.hist_long FROM monitor_state m
    JOIN users u ON u.id = m.user_id
    WHERE lower(u.email) = ${adminEmail}`;
  if (!src.length) return;

  // Fusion por timestamp: el punto del admin manda si hay choque, y el resultado
  // queda ordenado (las velas se derivan al vuelo asumiendo orden ascendente).
  const merge = (mine, theirs) => {
    const m = new Map();
    (theirs || []).forEach(p => { if (p && p.ts) m.set(p.ts, p); });
    (mine || []).forEach(p => { if (p && p.ts) m.set(p.ts, p); });
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  };
  const cur = rows[0] || {};
  const h24 = merge(histMap(src[0].hist24)[GLOBAL_PAY], histMap(cur.hist24)[GLOBAL_PAY]);
  const hLong = merge(histMap(src[0].hist_long)[GLOBAL_PAY], histMap(cur.hist_long)[GLOBAL_PAY]);
  if (!h24.length && !hLong.length) return;

  await sql`
    INSERT INTO market_hist (pay, hist24, hist_long, seeded, updated_at)
    VALUES (${GLOBAL_PAY}, ${JSON.stringify({ [GLOBAL_PAY]: h24 })}::jsonb,
            ${JSON.stringify({ [GLOBAL_PAY]: hLong })}::jsonb, true, now())
    ON CONFLICT (pay) DO UPDATE SET hist24 = excluded.hist24,
      hist_long = excluded.hist_long, seeded = true
    WHERE market_hist.seeded = false`;
}

async function tickGlobalHist() {
  await ensureMarketHist();
  await seedGlobalHist();
  // Claim atomico: con varios ticks solapados solo uno hace la busqueda.
  const claim = await sql`
    INSERT INTO market_hist (pay, updated_at) VALUES (${GLOBAL_PAY}, now())
    ON CONFLICT (pay) DO UPDATE SET updated_at = now()
    WHERE market_hist.updated_at < now() - ${GLOBAL_SAMPLE_MS + ' milliseconds'}::interval
    RETURNING pay`;
  if (!claim.length) return;

  const raw = await publicSearch({
    transAmount: GLOBAL_AMOUNT, pays: [GLOBAL_PAY], maxPages: 1,
    tradeType: 'SELL', verifiedOnly: true,
  });
  const price = bestOf(raw, true);
  if (!price) return;

  const cur = await sql`SELECT hist24, hist_long FROM market_hist WHERE pay = ${GLOBAL_PAY}`;
  const now = Date.now();
  const h24 = pushHist24Pay(cur[0] && cur[0].hist24, GLOBAL_PAY, now, price);
  const hLong = pushHistLongPay(cur[0] && cur[0].hist_long, GLOBAL_PAY, now, price);
  await sql`UPDATE market_hist SET hist24 = ${JSON.stringify(h24)}::jsonb,
    hist_long = ${JSON.stringify(hLong)}::jsonb WHERE pay = ${GLOBAL_PAY}`;
}

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

// Devuelve un objeto con el resultado del refresh, o un numero = ms hasta que
// vuelva a tocar trabajo (para que el scheduler espacie la alarma si puede).
async function tickMonitor(row, now) {
  const cfg = row.config || {};

  // Si la app esta abierta y refrescando (latido fresco), el cliente cubre el monitor:
  // el servidor no busca ni alerta (evita duplicar requests a Binance y mensajes Telegram).
  // Ventana 12 min (latido del cliente cada 5 min: 2 perdidos + margen). Antes eran
  // 35 min para mantener dormida la Neon vieja; en Supabase el compute no se cobra y
  // esa ventana solo dejaba al monitor 35 min ciego al cerrar la app.
  const seenMs = row.client_seen ? now - new Date(row.client_seen).getTime() : Infinity;
  if (seenMs < 12 * 60 * 1000) return 12 * 60 * 1000 - seenMs;

  // El silencio nocturno calla las notificaciones y afloja la cadencia a 5 min: eso deja
  // 3 puntos por vela de 15 min (suficiente para un O/H/L/C valido) contra los ~7 del dia.
  // (Antes bajaba a 1/hora para suspender la Neon vieja: eso si dejaba el grafico vacio
  // y, al terminar el silencio, sin referencias de 10/30/60 min para el momentum.)
  const silent = inQuietHours(cfg.quietStart, cfg.quietEnd, now);
  const refreshSec = silent ? Math.max(cfg.refreshSec || 30, 300) : (cfg.refreshSec || 30);
  const nextMs = refreshSec * 1000;

  // Respetar la cadencia (el tick base es ~18s; aqui decidimos si toca refrescar).
  const sinceTick = row.last_tick ? now - new Date(row.last_tick).getTime() : Infinity;
  if (sinceTick < refreshSec * 1000) return refreshSec * 1000 - sinceTick;

  // Claim atomico: si otro tick concurrente ya refresco a este usuario, saltar
  // (evita doble busqueda y doble alerta Telegram).
  const claim = await sql`
    UPDATE monitor_state SET last_tick = now()
    WHERE user_id = ${row.user_id} AND enabled = true
      AND (last_tick IS NULL OR last_tick < now() - interval '25 seconds')
    RETURNING user_id`;
  if (!claim.length) return 25 * 1000;

  // Columna pesada (hist_long acumula hasta 2 anios) SOLO cuando toca refrescar:
  // parsearlas en cada tick de 18s era CPU desperdiciada.
  const hrows = await sql`
    SELECT price_hist, cooldowns, hist24, hist_long, last_summary, log
    FROM monitor_state WHERE user_id = ${row.user_id}`;
  const h = hrows[0] || {};

  const pays = (cfg.payTypes && cfg.payTypes.length) ? cfg.payTypes : [];
  const verifiedOnly = cfg.verifiedOnly !== false;
  // Modo Short apagado: el par relevante es Verde (primario) vs Mayoristas (secundario),
  // Recompra no se pide. mayRaw se mantiene SIEMPRE con datos reales de Mayoristas
  // (topMedianRate/p2p_rate es la tasa publica del portfolio, ajena al modo del usuario).
  const shortOff = cfg.shortMode === false;
  const [mayRaw, otherRaw] = await Promise.all([
    publicSearch({ transAmount: cfg.mayAmount || 2000000, pays, maxPages: 1, tradeType: 'SELL', verifiedOnly }),
    shortOff
      ? publicSearch({ transAmount: cfg.buyAmount || 2000000, pays, maxPages: 1, tradeType: 'BUY', verifiedOnly })
      : publicSearch({ transAmount: cfg.smallAmount || 59999, pays, maxPages: 1, tradeType: 'SELL', verifiedOnly }),
  ]);
  const primaryRaw   = shortOff ? otherRaw : mayRaw;
  const secondaryRaw = shortOff ? mayRaw   : otherRaw;
  const labels = shortOff ? { primary: 'Verde', secondary: 'Mayorista' } : { primary: 'Mayorista', secondary: 'Compra' };

  const out = computeAlerts({ mayRaw: primaryRaw, smallRaw: secondaryRaw, cfg, priceHist: h.price_hist, cooldowns: h.cooldowns, now, silent, labels });
  const pay = pays[0] || 'BancoDeVenezuela';
  // Tasa USDT/VES publica (mediana top-10 mayoristas): la consume el portfolio.
  // Best-effort: un fallo aqui no debe tumbar el tick del monitor.
  const med = topMedianRate(mayRaw, 10, verifiedOnly);
  if (med) {
    await sql`INSERT INTO p2p_rate (pay, rate, n, updated_at) VALUES (${pay}, ${med.rate}, ${med.n}, now())
      ON CONFLICT (pay) DO UPDATE SET rate = excluded.rate, n = excluded.n, updated_at = now()`.catch(() => {});
  }
  // Historial de spread del mercado 24/7 (cada 5 min). El grabador del cliente solo
  // corre con la app abierta, asi que las horas sin mirar quedaban en blanco: son
  // justo las que hacen falta para saber si el capital estuvo parado con razon.
  if (out.spreadNet != null &&
      (!row.last_mkt || now - new Date(row.last_mkt).getTime() >= SAMPLE_MS)) {
    await sql`
      INSERT INTO market_snapshots (user_id, ts, may_best, rec_best, spread_net, commission)
      VALUES (${row.user_id}, now(), ${out.bestMay}, ${out.bestSmall}, ${out.spreadNet}, ${cfg.commission || 0})`
      .then(() => sql`UPDATE monitor_state SET last_mkt = now() WHERE user_id = ${row.user_id}`)
      .catch(() => {});
  }

  // Serie persistida "(mayorista)" del sparkline y el resumen diario: SIEMPRE
  // Mayoristas real, nunca out.bestMay (que en Modo Short apagado es Verde) —
  // si no, el grafico pega un salto falso cada vez que el usuario cambia de modo.
  const mayBestTrue = shortOff ? bestOf(mayRaw, verifiedOnly) : out.bestMay;
  const snap24 = histPaySnapshot(h.hist24, pay);
  const snapLong = histPaySnapshot(h.hist_long, pay);
  const hist24 = pushHist24Pay(h.hist24, pay, now, mayBestTrue);
  const histLong = pushHistLongPay(h.hist_long, pay, now, mayBestTrue);

  let log = h.log;
  const { token, chatId } = await resolveTelegram(row.user_id);

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
    lastSummary,
    log,
    // Solo re-serializar/escribir las series que realmente cambiaron (hist_long solo
    // suma 1 punto cada 30 min; stringify de anios de datos cada 30s era CPU pura).
    hist24Changed: histPayChanged(snap24, hist24, pay),
    histLongChanged: histPayChanged(snapLong, histLong, pay),
    status: silent ? '🌙 Silencio nocturno' : (out.bestMay ? '🟢 Vigilando ' + out.bestMay.toFixed(2) + ' Bs' : '🟢 Vigilando'),
    nextMs: nextMs,
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

// Aviso por Telegram (si esta configurado) + push. Best-effort, no rompe el tick.
async function botNotify(cfg, userId, tgMsg, pushTitle, pushBody) {
  const { token, chatId } = await resolveTelegram(userId);
  if (token && chatId) { try { await sendTelegram(token, chatId, tgMsg); } catch (e) {} }
  if (pushTitle) sendPush(userId, pushTitle, pushBody || '').catch(() => {});
}

// Estado LIVE del anuncio segun Binance (advStatus 1 = online; 3 = apagado).
function adIsLive(ad) {
  const st = ad.advStatus;
  return st === 'LIVE' || st === 'ONLINE' || st === 1 || st === '1' || ad.adStatus === 1;
}

async function tickUser(row) {
  const cfg = row.config || {};
  let log = row.log;
  let status = '';
  let adNumber = row.ad_number;
  let currentPrice = row.current_price;
  let lastReprice = row.last_reprice;
  let adAmount = row.ad_amount;
  let adHidden = row.ad_hidden;
  let adSeenAt = row.ad_seen_at;

  const key = decrypt({ ct: row.enc_key, iv: row.iv_key, tag: row.tag_key });
  const secret = decrypt({ ct: row.enc_secret, iv: row.iv_secret, tag: row.tag_secret });

  const my = await getMyAds(key, secret);
  if (!my.ok || !my.ads.length) {
    status = 'Sin anuncios';
    log = pushLog(log, 'Sin anuncios o API sin permiso', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
  }

  const ad = pickAd(my.ads, cfg.adNo);
  if (!ad) {
    status = 'Anuncio no encontrado';
    log = pushLog(log, 'Anuncio configurado no encontrado', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
  }

  // Anuncio apagado en Binance por el usuario -> detener el bot (no gastar requests).
  // Guarda: se ignora en el PRIMER tick (row.last_tick NULL) para no chocar con el
  // desfase de estado justo tras activar el anuncio al iniciar.
  if (row.last_tick && ad.advStatus != null && !adIsLive(ad)) {
    const adNo = String(ad.advNo || ad.adNumber);
    log = pushLog(log, '🛑 Anuncio apagado en Binance — bot detenido', 'warn');
    await botNotify(cfg, row.user_id, '🔴 <b>Bot detenido</b>\nApagaste el anuncio en Binance.',
      '🔴 Bot detenido', 'Apagaste el anuncio en Binance');
    return { enabled: false, status: 'Detenido: anuncio apagado', log, adNumber: adNo, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
  }

  const surplus = parseFloat(ad.surplusAmount || ad.tradableQuantity || ad.remainQuantity || 0);
  adAmount = surplus; // para el P&L del cliente: cantidad USDT restante en el anuncio
  if (surplus > 0 && surplus < 100) {
    // Pausar el anuncio en Binance: que no quede vivo y mal posicionado al apagarse el bot.
    const adNo = String(ad.advNo || ad.adNumber);
    const off = await setAdStatus(key, secret, adNo, 3).catch(() => ({ ok: false }));
    log = pushLog(log, off.ok ? '🛑 Fondos insuficientes (<100 USDT) — anuncio pausado y bot detenido'
                              : '🛑 Fondos insuficientes — bot detenido (no se pudo pausar el anuncio)', 'error');
    await botNotify(cfg, row.user_id,
      '🔴 <b>Bot detenido: fondos bajos</b>\nMenos de 100 USDT disponibles. Anuncio pausado.\n\nRecarga la cantidad del anuncio desde la app (Bot → Cantidad del anuncio → Aplicar ahora) y vuelve a iniciarlo.',
      '🔴 Bot detenido: fondos bajos', 'Menos de 100 USDT disponibles. Recarga la cantidad del anuncio y vuelve a iniciarlo.');
    return { enabled: false, status: 'Detenido: fondos bajos', log, adNumber: adNo, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
  }

  if (!cfg.sellPrice) {
    status = 'Falta precio de venta';
    log = pushLog(log, 'Configura el precio de venta', 'warn');
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
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

  // Oculto = vivo pero fuera del listado publico (Binance lo esconde con muchas ordenes
  // y lo devuelve solo). No cambia nada del reprice: solo se refleja en el panel.
  // null = indeterminado: se conserva el estado anterior. Y solo se concluye "oculto"
  // si alguna vez lo vimos en el libro (si no, seria un falso positivo permanente
  // cuando el anuncio no pasa los filtros de la busqueda).
  const hid = isAdHidden(ad, marketRaw);
  if (hid === false) { adSeenAt = new Date().toISOString(); adHidden = false; }
  else if (hid === true && adSeenAt) adHidden = true;
  if (row.ad_hidden != null && adHidden !== row.ad_hidden) {
    log = pushLog(log, adHidden ? '🙈 Anuncio oculto por Binance (muchas órdenes) — sigue repreciando'
                                : '👁 Anuncio visible de nuevo en el mercado', 'info');
  }

  const res = computeReprice({ ad, marketRaw, cfg });

  if (res.targetPrice === null) {
    status = res.reason;
    currentPrice = res.currentPrice;
    return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
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
  return { enabled: row.enabled, status, log, adNumber, currentPrice, lastReprice, adAmount, adHidden, adSeenAt };
}

// Notifica por Telegram las ordenes nuevas del usuario (24/7, app cerrada). Throttle ~60s.
// Primera vez: siembra known_orders sin notificar. Devuelve { known, checkedAt, log } o null.
async function maybeCheckOrders(row, now, notify = true) {
  if (row.orders_checked_at && now - new Date(row.orders_checked_at).getTime() < 60 * 1000) return null;
  const cfg = row.config || {};
  const key = decrypt({ ct: row.enc_key, iv: row.iv_key, tag: row.tag_key });
  const secret = decrypt({ ct: row.enc_secret, iv: row.iv_secret, tag: row.tag_secret });
  // Ventana adaptativa: cubre el hueco desde el ultimo chequeo (+5 min de margen).
  // Con bot apagado los ticks pueden espaciarse 35 min (app abierta) o 1h (noche);
  // los 15 min fijos dejarian ordenes sin capturar. Tope 24h (la API trae max 20 filas).
  const gapMs = row.orders_checked_at ? now - new Date(row.orders_checked_at).getTime() : 0;
  const sinceMs = Math.min(Math.max(15 * 60 * 1000, gapMs + 5 * 60 * 1000), 24 * 3600 * 1000);
  const { ok, orders, raw } = await listOrders(key, secret, sinceMs);
  const checkedAt = new Date(now).toISOString();
  let log = row.log;
  if (!ok) {
    log = pushLog(log, '⚠ Órdenes: API falló [' + ((raw && raw.code) || '?') + '] ' + ((raw && raw.message) || (raw ? JSON.stringify(raw).slice(0, 120) : '')), 'warn');
    return { known: row.known_orders, checkedAt, log };
  }

  // Persistir para metricas de rotacion (volumen/dia, tiempo entre ordenes).
  // Upsert de status: una orden PENDING de un chequeo anterior puede completarse despues.
  for (const o of orders) {
    try {
      const amt = parseFloat(o.amount || 0) || null;
      const total = parseFloat(o.totalPrice || 0) || null;
      const price = parseFloat(o.unitPrice || o.price || 0) || (amt && total ? total / amt : null);
      await sql`
        INSERT INTO orders (order_no, user_id, trade_type, amount, total, price, status, created_at)
        VALUES (${String(o.orderNumber)}, ${row.user_id}, ${o.tradeType || null}, ${amt}, ${total}, ${price},
                ${String(o.orderStatus != null ? o.orderStatus : '')}, ${o.createTime ? new Date(Number(o.createTime)).toISOString() : null})
        ON CONFLICT (order_no) DO UPDATE SET status = EXCLUDED.status`;
    } catch (e) {}
  }

  const ids = orders.map(o => String(o.orderNumber));
  const prev = Array.isArray(row.known_orders) ? row.known_orders : null;
  if (prev === null) {
    log = pushLog(log, '🔎 Órdenes: ' + orders.length + ' en historial 15min (sembrado inicial, sin avisar)', 'info');
    return { known: ids.slice(0, 50), checkedAt, log };
  }

  const knownSet = new Set(prev);
  const fresh = orders.filter(o => !knownSet.has(String(o.orderNumber)));
  const newKnown = Array.from(new Set([...ids, ...prev])).slice(0, 50);
  if (fresh.length && notify) {
    const { token, chatId } = await resolveTelegram(row.user_id);
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
    // Serie global del grafico: independiente de que haya o no usuarios con el
    // monitor encendido. Best-effort, nunca debe tumbar el tick del bot.
    try { await tickGlobalHist(); } catch (e) {}

    // Solo se tickea a quien tiene prueba vigente o periodo pagado (el admin queda
    // exento). Sin esto cualquiera cerraba el popup de suscripcion y el bot y el
    // monitor 24/7 le corrian igual, a costa nuestra.
    const adminId = await adminUserId();
    // Cortesia tras vencer: el pago es manual, un despiste de horas no debe cortarle
    // el bot a nadie. Los avisos de sweepRenewals le explican al usuario que pasa.
    const graceFrom = new Date(Date.now() - GRACE_MS).toISOString();
    try { await sweepRenewals(); } catch (e) {}

    // Sin ensureSchema(): el schema ya existe (lo crean los endpoints de auth/app).
    // Correr ~25 DDLs por cold start cada 18s era costo inutil.
    const rows = await sql`
      SELECT b.user_id, b.enabled, b.config, b.ad_number, b.current_price, b.last_reprice, b.log,
             b.known_orders, b.orders_checked_at, b.ad_amount, b.ad_hidden, b.ad_seen_at, b.last_sample,
             c.enc_key, c.iv_key, c.tag_key, c.enc_secret, c.iv_secret, c.tag_secret
      FROM bot_state b
      JOIN binance_creds c ON c.user_id = b.user_id
      LEFT JOIN subscriptions s ON s.user_id = b.user_id
      WHERE b.enabled = true
        AND (b.user_id = ${adminId}
          OR (s.status = 'trialing' AND s.trial_end > now())
          OR (s.status = 'active' AND s.current_period_end > ${graceFrom}))
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
        // Conserva el estado del anuncio: un fallo puntual del tick no debe borrar la
        // cantidad (P&L) ni el estado de visibilidad ya conocidos.
        out = { enabled: row.enabled, status: 'Error: ' + e.message, log: pushLog(row.log, 'Error: ' + e.message, 'error'),
                adNumber: row.ad_number, currentPrice: row.current_price, lastReprice: row.last_reprice,
                adAmount: row.ad_amount, adHidden: row.ad_hidden, adSeenAt: row.ad_seen_at };
      }
      // Notificacion de ordenes nuevas (independiente del reprice; usa el log ya actualizado).
      let knownOrders = row.known_orders, ordersCheckedAt = row.orders_checked_at;
      if (out.enabled) {
        try {
          const oc = await maybeCheckOrders({ ...row, log: out.log }, Date.now());
          if (oc) { knownOrders = oc.known; ordersCheckedAt = oc.checkedAt; if (oc.log) out.log = oc.log; }
        } catch (e) {}
      }
      // Muestra cada 5 min del estado del anuncio (spread vigente, oculto, saldo).
      // Es la unica forma de saber despues que spread llenaba mas rapido y cuanto
      // tiempo estuvo el capital parado: la config viva no deja rastro historico.
      const sampleNow = out.enabled &&
        (!row.last_sample || Date.now() - new Date(row.last_sample).getTime() >= SAMPLE_MS);
      // enabled = enabled AND out.enabled: el tick solo puede APAGAR, nunca re-encender.
      // Si el usuario pulso Detener mientras este tick corria, no resucitar el bot.
      await sql`
        UPDATE bot_state SET
          enabled = enabled AND ${out.enabled},
          status = ${out.status || null},
          log = ${JSON.stringify(out.log || [])}::jsonb,
          ad_number = ${out.adNumber || null},
          current_price = ${out.currentPrice != null ? out.currentPrice : null},
          ad_amount = ${out.adAmount != null ? out.adAmount : null},
          ad_hidden = ${out.adHidden != null ? out.adHidden : null},
          ad_seen_at = ${out.adSeenAt || null},
          last_reprice = ${out.lastReprice || null},
          known_orders = ${knownOrders != null ? JSON.stringify(knownOrders) : null}::jsonb,
          orders_checked_at = ${ordersCheckedAt || null},
          last_sample = ${sampleNow ? new Date().toISOString() : (row.last_sample || null)},
          updated_at = now()
        WHERE user_id = ${row.user_id}`;
      if (sampleNow) {
        const scfg = row.config || {};
        await sql`
          INSERT INTO bot_samples (user_id, ts, min_spread, ad_hidden, ad_amount, price)
          VALUES (${row.user_id}, now(), ${scfg.minSpread != null ? scfg.minSpread : null},
                  ${out.adHidden === true}, ${out.adAmount != null ? out.adAmount : null},
                  ${out.currentPrice != null ? out.currentPrice : null})`.catch(() => {});
      }
      // OJO: last_tick NO se re-sella aqui: lo marca el claim al INICIO del tick.
      // Sellarlo al final sumaba el tiempo de proceso y hacia saltar 1 de cada 2 ticks (~36s).
      ticked++;
    }

    // Captura de ordenes con el bot APAGADO (ventas manuales del usuario): monta
    // sobre la cadencia del monitor, sin notificar ni tocar el log — solo persiste
    // en la tabla orders para las metricas de rotacion.
    const qrows = await sql`
      SELECT b.user_id, b.known_orders, b.orders_checked_at, b.log,
             c.enc_key, c.iv_key, c.tag_key, c.enc_secret, c.iv_secret, c.tag_secret
      FROM bot_state b
      JOIN binance_creds c ON c.user_id = b.user_id
      JOIN monitor_state m ON m.user_id = b.user_id AND m.enabled = true
      LEFT JOIN subscriptions s ON s.user_id = b.user_id
      WHERE b.enabled = false
        AND (b.user_id = ${adminId}
          OR (s.status = 'trialing' AND s.trial_end > now())
          OR (s.status = 'active' AND s.current_period_end > ${graceFrom}))
      LIMIT ${MAX_USERS}`;
    for (const row of qrows) {
      try {
        const oc = await maybeCheckOrders(row, Date.now(), false);
        if (oc) await sql`
          UPDATE bot_state SET
            known_orders = ${oc.known != null ? JSON.stringify(oc.known) : null}::jsonb,
            orders_checked_at = ${oc.checkedAt}
          WHERE user_id = ${row.user_id}`;
      } catch (e) {}
    }

    // Monitor server-side (alertas Telegram 24/7 con silencio nocturno).
    // SELECT liviano: las columnas pesadas se leen dentro de tickMonitor solo si toca refrescar.
    const mrows = await sql`
      SELECT m.user_id, m.config, m.last_tick, m.client_seen, m.last_mkt
      FROM monitor_state m
      LEFT JOIN subscriptions s ON s.user_id = m.user_id
      WHERE m.enabled = true
        AND (m.user_id = ${adminId}
          OR (s.status = 'trialing' AND s.trial_end > now())
          OR (s.status = 'active' AND s.current_period_end > ${graceFrom}))
      LIMIT ${MAX_USERS}`;
    let monitored = 0;
    // ms hasta el proximo trabajo real: el scheduler espacia su alarma con esto.
    // Con bots activos siempre hay trabajo en el proximo tick.
    let nextMs = rows.length ? 0 : Infinity;
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
      if (typeof out === 'number') { nextMs = Math.min(nextMs, out); continue; } // no toca refrescar aun
      nextMs = Math.min(nextMs, out.nextMs || 0);
      await sql`
        UPDATE monitor_state SET
          price_hist = ${JSON.stringify(out.priceHist || [])}::jsonb,
          cooldowns = ${JSON.stringify(out.cooldowns || {})}::jsonb,
          hist24 = COALESCE(${out.hist24Changed ? JSON.stringify(out.hist24 || []) : null}::jsonb, hist24),
          hist_long = COALESCE(${out.histLongChanged ? JSON.stringify(out.histLong || []) : null}::jsonb, hist_long),
          last_summary = ${out.lastSummary || null},
          log = ${JSON.stringify(out.log || [])}::jsonb,
          status = ${out.status || null},
          updated_at = now()
        WHERE user_id = ${row.user_id}`;
      monitored++;
    }

    // bots/monitors: se los lee el scheduler de CF para adaptar la cadencia
    // (18s con bots, 30s solo-monitor, backoff si no hay nada habilitado).
    // nextSec: sin bots, cuando toca el proximo refresh de monitor. tickMonitor
    // ya devuelve cuanto falta (incluye silencio nocturno y latido del cliente).
    const nextSec = (!rows.length && mrows.length && nextMs !== Infinity)
      ? Math.max(Math.round(nextMs / 1000), 5) : null;
    return res.status(200).json({ ok: true, ticked, monitored, bots: rows.length, monitors: mrows.length, nextSec });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
