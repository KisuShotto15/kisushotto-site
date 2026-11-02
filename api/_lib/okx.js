// Cliente de la P2P API de OKX (solo para comerciantes aprobados; doc privada de OKX,
// "API Specs - External"). Firma estandar de la API v5:
//   OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body))
// con timestamp ISO y la passphrase de la key en OK-ACCESS-PASSPHRASE. En GET la query
// va dentro de requestPath y el body es vacio.
import crypto from 'node:crypto';

const OKX = 'https://www.okx.com';

export function okxSign(secret, ts, method, requestPath, body) {
  return crypto.createHmac('sha256', secret).update(ts + method + requestPath + (body || '')).digest('base64');
}

// creds = { key, secret, passphrase }. Devuelve { ok, status, code, msg, data }.
// La doc muestra code numerico (0); la API v5 general lo manda como texto ("0").
export async function okxRequest(creds, method, path, params) {
  let requestPath = path;
  let body = '';
  if (method === 'GET' && params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.append(k, String(v));
    const qs = q.toString();
    if (qs) requestPath += '?' + qs;
  } else if (method !== 'GET') {
    body = JSON.stringify(params || {});
  }
  const ts = new Date().toISOString();
  const r = await fetch(OKX + requestPath, {
    method,
    headers: {
      'OK-ACCESS-KEY': creds.key,
      'OK-ACCESS-SIGN': okxSign(creds.secret, ts, method, requestPath, body),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': creds.passphrase,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json().catch(() => null);
  const code = j && j.code != null ? String(j.code) : null;
  return { ok: r.ok && code === '0', status: r.status, code, msg: (j && (j.msg || j.message)) || '', data: j ? j.data : null };
}

// ── Endpoints usados ──────────────────────────────────
export const okxBasicInfo = creds => okxRequest(creds, 'GET', '/api/v5/p2p/user/basic-info');
export const okxActiveAds = (creds, { side, fiat, crypto = 'USDT' }) =>
  okxRequest(creds, 'GET', '/api/v5/p2p/ad/active-list', { side, cryptoCurrency: crypto, fiatCurrency: fiat });
export const okxPendingOrders = (creds, adId) =>
  okxRequest(creds, 'GET', '/api/v5/p2p/order/pending-order', { adId });
// Libro publico. amount = monto en fiat que el anuncio debe aceptar por orden (el
// equivalente al transAmount de Binance).
export const okxMarketplace = (creds, { side = 'all', fiat, crypto = 'USDT', paymentMethod, amount, limit = 20, sortType }) =>
  okxRequest(creds, 'GET', '/api/v5/p2p/ad/marketplace-list', {
    side, cryptoCurrency: crypto, fiatCurrency: fiat, paymentMethod,
    minFiatAmountPerOrder: amount > 0 ? amount : undefined, limit, sortType,
  });
// Precio fijo: si el anuncio era flotante, unitPrice se ignora sin type=limit.
// OKX cancela el anuncio y crea otro: la respuesta trae newAdId.
export const okxUpdatePrice = (creds, adId, price) =>
  okxRequest(creds, 'POST', '/api/v5/p2p/ad/update', { adId: String(adId), type: 'limit', unitPrice: String(price) });

// status: 'show' (publicar) u 'hidden' (ocultar).
export const okxSetAdStatus = (creds, adId, status) =>
  okxRequest(creds, 'POST', '/api/v5/p2p/ad/update-active-status', { adId: String(adId), status });

// ── Adaptador al reprice de Binance (computeReprice en reprice.js) ──
// Mi anuncio de active-list → la forma de getMyAds de Binance.
export function okxAdForReprice(ad) {
  return {
    advNo: String(ad.adId), price: ad.unitPrice, minSingleTransAmount: ad.minOrderSize,
    fiat: ad.fiatCurrency ? String(ad.fiatCurrency).toUpperCase() : undefined,
    tradeMethods: (Array.isArray(ad.paymentMethods) ? ad.paymentMethods : []).map(id => ({ identifier: id })),
  };
}
// Anuncio del libro de OKX → la forma de publicSearch de Binance.
export function okxRawForReprice(ad) {
  const a = mapOkxAd(ad);
  return {
    adv: { advNo: a.advNo, price: String(a.price), minSingleTransAmount: String(a.minVES), maxSingleTransAmount: String(a.maxVES),
           tradableQuantity: String(a.avail), tradeMethods: a.payTypes.map(id => ({ identifier: id })) },
    advertiser: { nickName: a.merchant, badges: a.badges },
  };
}
// Lista de compradores del libro (marketplace-list side=buy) en bruto.
export function okxBuyAds(data) {
  const d = Array.isArray(data) ? (data[0] || {}) : (data || {});
  return Array.isArray(d.buyAds) ? d.buyAds : [];
}
// Redondeo al paso de precio de OKX sin pasarse del techo.
export function okxRoundPrice(price, step, ceiling) {
  const s = step > 0 ? step : 0.001;
  const dec = Math.max(0, Math.round(-Math.log10(s)));
  let p = Number((Math.round(price / s) * s).toFixed(dec));
  if (ceiling != null && p > ceiling + 1e-9) p = Number((p - s).toFixed(dec));
  return p;
}

// ── Normalizacion ─────────────────────────────────────
// Anuncio de OKX → la misma forma que usa el monitor para Binance (ver mapAds en
// main.js), asi el libro se dibuja con el mismo codigo.
// Lados: un "buy ad" de OKX es de alguien que COMPRA cripto (Compradores, donde
// vendes); un "sell ad" es de alguien que vende (Vendedores, donde compras).
export function mapOkxAd(ad) {
  const c = (ad && ad.creator) || {};
  const rate = parseFloat(c.completionRate);
  return {
    advNo: String(ad.adId || ''),
    price: parseFloat(ad.unitPrice),
    minVES: parseFloat(ad.minOrderSize),
    maxVES: parseFloat(ad.maxOrderSize),
    avail: parseFloat(ad.availableAmount),
    merchant: c.nickName || '',
    orders: parseInt(c.completedOrders, 10) || 0,
    comp: isFinite(rate) ? Math.round((rate <= 1 ? rate * 100 : rate)) : 0,
    payTypes: Array.isArray(ad.paymentMethods) ? ad.paymentMethods : [],
    // certified/diamond = verificado; common = sin insignia (igual que badges null en Binance)
    badges: c.type === 'certified' || c.type === 'diamond' ? [c.type] : null,
    vipLevel: c.type === 'diamond' ? 3 : (c.type === 'certified' ? 2 : 0),
    // Ojo: la doc de OKX lo manda como texto ("false"), y !!"false" es true.
    isOwner: ad.isOwner === true || ad.isOwner === 'true',
  };
}

// marketplace-list devuelve data: [{ buyAds: [...], sellAds: [...] }] (o el objeto
// suelto). Compradores de mayor a menor precio; vendedores de menor a mayor.
export function splitMarketplace(data) {
  const d = Array.isArray(data) ? (data[0] || {}) : (data || {});
  const ok = a => a.price > 0 && a.avail > 0;
  const buyers = (Array.isArray(d.buyAds) ? d.buyAds : []).map(mapOkxAd).filter(ok).sort((a, b) => b.price - a.price);
  const sellers = (Array.isArray(d.sellAds) ? d.sellAds : []).map(mapOkxAd).filter(ok).sort((a, b) => a.price - b.price);
  return { buyers, sellers };
}
