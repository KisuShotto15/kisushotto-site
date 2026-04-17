import crypto from 'node:crypto';

const BINANCE = 'https://api.binance.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bot-Token, X-Api-Secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const botToken = process.env.BOT_TOKEN;
  if (botToken && req.headers['x-bot-token'] !== botToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { path, params } = req.body || {};
  const key = process.env.BINANCE_KEY;
  const secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return res.status(500).json({ error: 'BINANCE_KEY/BINANCE_SECRET env vars not configured' });

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
  } else if (path === '/update-limit') {
    const { advNo, minSingleTransAmount } = params || {};
    if (!advNo || minSingleTransAmount == null) return res.status(400).json({ error: 'advNo y minSingleTransAmount requeridos' });
    // Fetch current ad to build a full update payload (API requires all fields)
    const detailParams = `adsNo=${encodeURIComponent(advNo)}&timestamp=${timestamp}`;
    const detailQs = `${detailParams}&signature=${sign(detailParams)}`;
    const detailHeaders = { 'X-MBX-APIKEY': key, 'clientType': 'web' };
    const detailRes = await fetch(`${BINANCE}/sapi/v1/c2c/ads/getDetailByNo?${detailQs}`, { headers: detailHeaders });
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
  } else {
    return res.status(404).json({ error: 'Unknown path' });
  }

  const data = await r.json();
  res.status(r.ok ? 200 : 502).json(data);
}
