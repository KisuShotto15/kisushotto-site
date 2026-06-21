import crypto from 'node:crypto';
import { requireAllowedUser } from './_lib/auth.js';
import { sql, ensureSchema } from './_lib/db.js';
import { decrypt } from './_lib/crypto.js';

const BINANCE = 'https://api.binance.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let user;
  try { user = requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  const { path, params } = req.body || {};

  // Credenciales Binance del usuario autenticado (cifradas en DB)
  let key, secret;
  try {
    await ensureSchema();
    const rows = await sql`SELECT enc_key, iv_key, tag_key, enc_secret, iv_secret, tag_secret FROM binance_creds WHERE user_id = ${user.uid}`;
    if (!rows.length) return res.status(400).json({ error: 'Conecta tu cuenta Binance primero' });
    const c = rows[0];
    key = decrypt({ ct: c.enc_key, iv: c.iv_key, tag: c.tag_key });
    secret = decrypt({ ct: c.enc_secret, iv: c.iv_secret, tag: c.tag_secret });
  } catch (e) {
    return res.status(500).json({ error: 'Error leyendo credenciales: ' + e.message });
  }

  function sign(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  const timestamp = Date.now();
  const bodyObj = { ...(params || {}), timestamp };  // timestamp in body for SAPI
  const bodyStr = JSON.stringify({ ...params });
  const qs = `timestamp=${timestamp}&signature=${sign(`timestamp=${timestamp}`)}`;

  const headers = { 'X-MBX-APIKEY': key, 'Content-Type': 'application/json', 'clientType': 'web' };

  let r;
  if (path === '/ping') {
    // Test connectivity to Binance
    const t = await fetch(`${BINANCE}/api/v3/time`).then(r => r.json()).catch(e => ({ error: e.message }));
    return res.json({ ok: true, keyLen: key.length, binanceTime: t.serverTime || t.error });
  }

  if (path === '/my-ads') {
    const body = JSON.stringify({ page: 1, rows: 20, tradeType: 'BUY', asset: 'USDT', fiatUnit: 'VES' });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/listWithPagination?${qs}`, { method: 'POST', headers, body });
  } else if (path === '/update-ad') {
    const { advNo, price } = params || {};
    if (!advNo || price == null) return res.status(400).json({ error: 'advNo y price requeridos' });
    const body = JSON.stringify({ advNo: String(advNo), price: Number(price) });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/update?${qs}`, { method: 'POST', headers, body });
  } else if (path === '/update-quantity') {
    const { advNo, totalAmount } = params || {};
    if (!advNo || totalAmount == null) return res.status(400).json({ error: 'advNo y totalAmount requeridos' });
    const detailParams = `adsNo=${encodeURIComponent(advNo)}&timestamp=${timestamp}`;
    const detailQs = `${detailParams}&signature=${sign(detailParams)}`;
    const detailHeaders = { 'X-MBX-APIKEY': key, 'clientType': 'web' };
    const detailRes = await fetch(`${BINANCE}/sapi/v1/c2c/ads/getDetailByNo?${detailQs}`, { method: 'POST', headers: detailHeaders });
    const detail = await detailRes.json();
    if (!detailRes.ok || !detail.data) return res.status(200).json({ code: 'DETAIL_FAILED', message: JSON.stringify(detail).substring(0, 200) });
    const ad = detail.data;
    const body = JSON.stringify({
      advNo: String(advNo),
      asset: ad.asset,
      tradeType: ad.tradeType,
      fiatUnit: ad.fiatUnit,
      priceType: ad.priceType,
      price: ad.price,
      priceFloatingRatio: ad.priceFloatingRatio,
      initAmount: String((parseFloat(ad.initAmount) - parseFloat(ad.surplusAmount || 0) + parseFloat(totalAmount)).toFixed(8)),
      minSingleTransAmount: ad.minSingleTransAmount,
      maxSingleTransAmount: ad.maxSingleTransAmount,
      payTimeLimit: ad.payTimeLimit,
      tradeMethods: ad.tradeMethods || [],
      remarks: ad.remarks || '',
      autoReplyMsg: ad.autoReplyMsg || '',
      advStatus: ad.advStatus,
    });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/update?${qs}`, { method: 'POST', headers, body });
  } else if (path === '/update-limit') {
    const { advNo, minSingleTransAmount } = params || {};
    if (!advNo || minSingleTransAmount == null) return res.status(400).json({ error: 'advNo y minSingleTransAmount requeridos' });
    // Fetch current ad to build a full update payload (API requires all fields)
    const detailParams = `adsNo=${encodeURIComponent(advNo)}&timestamp=${timestamp}`;
    const detailQs = `${detailParams}&signature=${sign(detailParams)}`;
    const detailHeaders = { 'X-MBX-APIKEY': key, 'clientType': 'web' };
    const detailRes = await fetch(`${BINANCE}/sapi/v1/c2c/ads/getDetailByNo?${detailQs}`, { method: 'POST', headers: detailHeaders });
    const detail = await detailRes.json();
    if (!detailRes.ok || !detail.data) {
      return res.status(502).json({ error: 'getDetailByNo failed', detail });
    }
    const ad = detail.data;
    const body = JSON.stringify({
      advNo: String(advNo),
      asset: ad.asset,
      tradeType: ad.tradeType,
      fiatUnit: ad.fiatUnit,
      priceType: ad.priceType,
      price: ad.price,
      priceFloatingRatio: ad.priceFloatingRatio,
      initAmount: ad.initAmount,
      minSingleTransAmount: Number(minSingleTransAmount),
      maxSingleTransAmount: ad.maxSingleTransAmount,
      payTimeLimit: ad.payTimeLimit,
      tradeMethods: ad.tradeMethods || [],
      remarks: ad.remarks || '',
      autoReplyMsg: ad.autoReplyMsg || '',
      advStatus: ad.advStatus,
    });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/update?${qs}`, { method: 'POST', headers, body });
  } else if (path === '/toggle-ad') {
    const { advNo, advStatus } = params || {};
    if (!advNo || advStatus == null) return res.status(400).json({ error: 'advNo y advStatus requeridos' });
    const body = JSON.stringify({ advNos: [String(advNo)], advStatus: Number(advStatus) });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/updateStatus?${qs}`, { method: 'POST', headers, body });
  } else if (path === '/orders') {
    const sinceMs = Number((params || {}).sinceMs) || (2 * 60 * 60 * 1000);
    const body = JSON.stringify({
      page: 1, rows: 20,
      startTimestamp: timestamp - sinceMs,
      endTimestamp: timestamp
    });
    r = await fetch(`${BINANCE}/sapi/v1/c2c/orderMatch/listUserOrderHistory?${qs}`, { method: 'POST', headers, body });
  } else {
    return res.status(404).json({ error: 'Unknown path' });
  }

  const data = await r.json().catch(() => ({ error: 'invalid JSON from Binance' }));
  res.status(200).json(data);
}
