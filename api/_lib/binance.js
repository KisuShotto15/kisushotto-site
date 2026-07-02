// Helpers Binance C2C (firmados) + busqueda publica. Compartido por binance-bot.js y bot-tick.js.
// Replica exactamente el patron de firma usado historicamente: la query firmada es
// solo `timestamp=...` y los params reales van en el BODY (para los updates), salvo
// getDetailByNo que firma `adsNo=...&timestamp=...` en la query.
import crypto from 'node:crypto';

const BINANCE = 'https://api.binance.com';
const PUBLIC_SEARCH = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

// fetch con timeout: un cuelgue de Binance no debe consumir los 60s del tick
// y bloquear al resto de usuarios.
function fx(url, opts, ms) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms || 12000) });
}

export function sign(secret, qs) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

function tsQs(secret) {
  const ts = Date.now();
  return { ts, qs: `timestamp=${ts}&signature=${sign(secret, `timestamp=${ts}`)}` };
}

function headers(key) {
  return { 'X-MBX-APIKEY': key, 'Content-Type': 'application/json', 'clientType': 'web' };
}

// Lista de anuncios del usuario (BUY USDT/VES por defecto).
export async function getMyAds(key, secret) {
  const { qs } = tsQs(secret);
  const body = JSON.stringify({ page: 1, rows: 20, tradeType: 'BUY', asset: 'USDT', fiatUnit: 'VES' });
  const r = await fx(`${BINANCE}/sapi/v1/c2c/ads/listWithPagination?${qs}`, { method: 'POST', headers: headers(key), body });
  const data = await r.json().catch(() => ({}));
  const ads = Array.isArray(data.data) ? data.data
            : (data.data && Array.isArray(data.data.data)) ? data.data.data : [];
  return { ok: r.ok, ads, raw: data };
}

export async function getDetailByNo(key, secret, advNo) {
  const ts = Date.now();
  const params = `adsNo=${encodeURIComponent(advNo)}&timestamp=${ts}`;
  const qs = `${params}&signature=${sign(secret, params)}`;
  const r = await fx(`${BINANCE}/sapi/v1/c2c/ads/getDetailByNo?${qs}`, {
    method: 'POST', headers: { 'X-MBX-APIKEY': key, 'clientType': 'web' },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && !!data.data, ad: data.data, raw: data };
}

export async function updateAdPrice(key, secret, advNo, price) {
  const { qs } = tsQs(secret);
  const body = JSON.stringify({ advNo: String(advNo), price: Number(price) });
  const r = await fx(`${BINANCE}/sapi/v1/c2c/ads/update?${qs}`, { method: 'POST', headers: headers(key), body });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

// Cambia minSingleTransAmount; requiere reenviar el anuncio completo (igual que el cliente).
export async function updateMinLimit(key, secret, advNo, minSingleTransAmount) {
  const det = await getDetailByNo(key, secret, advNo);
  if (!det.ok) return { ok: false, data: { code: 'DETAIL_FAILED', message: JSON.stringify(det.raw).slice(0, 200) } };
  const ad = det.ad;
  const { qs } = tsQs(secret);
  const body = JSON.stringify({
    advNo: String(advNo),
    asset: ad.asset, tradeType: ad.tradeType, fiatUnit: ad.fiatUnit,
    priceType: ad.priceType, price: ad.price, priceFloatingRatio: ad.priceFloatingRatio,
    initAmount: ad.initAmount,
    minSingleTransAmount: Number(minSingleTransAmount),
    maxSingleTransAmount: ad.maxSingleTransAmount,
    payTimeLimit: ad.payTimeLimit, tradeMethods: ad.tradeMethods || [],
    remarks: ad.remarks || '', autoReplyMsg: ad.autoReplyMsg || '', advStatus: ad.advStatus,
  });
  const r = await fx(`${BINANCE}/sapi/v1/c2c/ads/update?${qs}`, { method: 'POST', headers: headers(key), body });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

// Cambia el estado del anuncio (3 = pausar/offline, 1 = activar). Igual que el toggle-ad del cliente.
export async function setAdStatus(key, secret, advNo, advStatus) {
  const { qs } = tsQs(secret);
  const body = JSON.stringify({ advNos: [String(advNo)], advStatus: Number(advStatus) });
  const r = await fx(`${BINANCE}/sapi/v1/c2c/ads/updateStatus?${qs}`, { method: 'POST', headers: headers(key), body });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

// Historial de ordenes C2C del usuario (para notificar ordenes nuevas server-side).
// Endpoint SAPI estandar: TODOS los params van en la query firmada (no en el body).
export async function listOrders(key, secret, sinceMs) {
  const ts = Date.now();
  const params = `startTimestamp=${ts - (sinceMs || 2 * 3600 * 1000)}&endTimestamp=${ts}&page=1&rows=20&recvWindow=10000&timestamp=${ts}`;
  const url = `${BINANCE}/sapi/v1/c2c/orderMatch/listUserOrderHistory?${params}&signature=${sign(secret, params)}`;
  const r = await fx(url, { method: 'GET', headers: { 'X-MBX-APIKEY': key } });
  const data = await r.json().catch(() => ({}));
  const orders = Array.isArray(data.data) ? data.data : [];
  const ok = r.ok && (data.code == null || data.code === '000000' || data.code === 0);
  return { ok, orders, raw: data };
}

// Body de busqueda publica (espejo de buildSearchBody del cliente).
export function buildSearchBody({ transAmount, page, pays, tradeType }) {
  const body = {
    asset: 'USDT', fiat: 'VES', merchantCheck: false,
    page, rows: 20, tradeType: tradeType || 'SELL', payTypes: pays,
  };
  if (transAmount && parseFloat(transAmount) > 0) body.transAmount = String(transAmount);
  return body;
}

// Busqueda publica (Vercel SI puede; CF esta bloqueado por Binance). Devuelve items crudos {adv, advertiser}.
export async function publicSearch({ transAmount, pays, maxPages = 2, tradeType = 'SELL' }) {
  const bodies = [];
  for (let i = 1; i <= maxPages; i++) bodies.push(buildSearchBody({ transAmount, page: i, pays, tradeType }));
  const settled = await Promise.allSettled(bodies.map(b =>
    fx(PUBLIC_SEARCH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }, 9000).then(r => r.json())
  ));
  return settled.flatMap(s => (s.status === 'fulfilled' && Array.isArray(s.value.data)) ? s.value.data : []);
}
