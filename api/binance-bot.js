import crypto from 'node:crypto';
import { requireAllowedUser } from './_lib/auth.js';
import { sql, ensureSchema } from './_lib/db.js';
import { decrypt, encrypt } from './_lib/crypto.js';
import { pushHist24, pushHistLong } from './_lib/monitor.js';

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

  // Preferencias del usuario (sync entre dispositivos). No requiere creds Binance.
  if (path === '/settings-get' || path === '/settings-save') {
    try {
      await ensureSchema();
      if (path === '/settings-save') {
        const data = JSON.stringify((params && params.data) || {});
        await sql`
          INSERT INTO user_settings (user_id, data, updated_at)
          VALUES (${user.uid}, ${data}::jsonb, now())
          ON CONFLICT (user_id) DO UPDATE SET data = ${data}::jsonb, updated_at = now()`;
        return res.status(200).json({ ok: true });
      }
      const rows = await sql`SELECT data FROM user_settings WHERE user_id = ${user.uid}`;
      return res.status(200).json({ data: rows[0] ? rows[0].data : null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Control del bot server-side (no requiere creds Binance descifradas aqui).
  if (path === '/bot-enable' || path === '/bot-disable' || path === '/bot-state' || path === '/bot-config') {
    try {
      await ensureSchema();
      if (path === '/bot-enable') {
        const c = (params && params.config) || {};
        if (c.tg && c.tg.token) c.tg = { token_enc: encrypt(c.tg.token), chatId: c.tg.chatId || '' };
        const cfg = JSON.stringify(c);
        // Reset de estado de la corrida anterior: si no, el poller pinta el precio/log viejos
        // y sobrescribe el reprice inicial fresco del cliente.
        await sql`
          INSERT INTO bot_state (user_id, enabled, config, status, updated_at)
          VALUES (${user.uid}, true, ${cfg}::jsonb, 'Iniciando...', now())
          ON CONFLICT (user_id) DO UPDATE SET enabled = true, config = ${cfg}::jsonb, status = 'Iniciando...',
            current_price = NULL, last_reprice = NULL, last_tick = NULL, ad_number = NULL, log = '[]'::jsonb,
            known_orders = NULL, orders_checked_at = NULL, updated_at = now()`;
        return res.status(200).json({ ok: true });
      }
      if (path === '/bot-disable') {
        await sql`UPDATE bot_state SET enabled = false, status = 'Detenido', updated_at = now() WHERE user_id = ${user.uid}`;
        return res.status(200).json({ ok: true });
      }
      if (path === '/bot-config') {
        // Actualiza la config en caliente (sin resetear precio/log) para el bot ya corriendo.
        const c = (params && params.config) || {};
        if (c.tg && c.tg.token) c.tg = { token_enc: encrypt(c.tg.token), chatId: c.tg.chatId || '' };
        const cfg = JSON.stringify(c);
        await sql`UPDATE bot_state SET config = ${cfg}::jsonb, updated_at = now() WHERE user_id = ${user.uid} AND enabled = true`;
        return res.status(200).json({ ok: true });
      }
      const rows = await sql`SELECT enabled, config, ad_number, current_price, last_reprice, last_tick, status, log FROM bot_state WHERE user_id = ${user.uid}`;
      return res.status(200).json(rows[0] || { enabled: false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Control del monitor server-side (alertas Telegram 24/7). No requiere creds Binance.
  if (path === '/monitor-enable' || path === '/monitor-disable' || path === '/monitor-state' || path === '/monitor-heartbeat' || path === '/monitor-history') {
    try {
      await ensureSchema();
      if (path === '/monitor-enable') {
        const cfg = (params && params.config) || {};
        if (cfg.tg && cfg.tg.token) {
          cfg.tg = { token_enc: encrypt(cfg.tg.token), chatId: cfg.tg.chatId || '' };
        }
        const cfgStr = JSON.stringify(cfg);
        await sql`
          INSERT INTO monitor_state (user_id, enabled, config, status, updated_at)
          VALUES (${user.uid}, true, ${cfgStr}::jsonb, 'Iniciando...', now())
          ON CONFLICT (user_id) DO UPDATE SET enabled = true, config = ${cfgStr}::jsonb, status = 'Iniciando...', updated_at = now()`;
        return res.status(200).json({ ok: true });
      }
      if (path === '/monitor-disable') {
        await sql`UPDATE monitor_state SET enabled = false, status = 'Detenido', updated_at = now() WHERE user_id = ${user.uid}`;
        return res.status(200).json({ ok: true });
      }
      if (path === '/monitor-heartbeat') {
        // La app abierta avisa que esta refrescando; el servidor se queda quieto mientras tanto.
        // De paso alimenta hist24 con el precio que ve el cliente, asi el sparkline no queda hueco de dia.
        const price = Number((params && params.price) || 0);
        if (price > 0) {
          const cur = await sql`SELECT hist24, hist_long FROM monitor_state WHERE user_id = ${user.uid}`;
          const h = pushHist24(cur[0] ? cur[0].hist24 : [], Date.now(), price);
          const hl = pushHistLong(cur[0] ? cur[0].hist_long : [], Date.now(), price);
          await sql`UPDATE monitor_state SET client_seen = now(), hist24 = ${JSON.stringify(h)}::jsonb, hist_long = ${JSON.stringify(hl)}::jsonb WHERE user_id = ${user.uid}`;
        } else {
          await sql`UPDATE monitor_state SET client_seen = now() WHERE user_id = ${user.uid}`;
        }
        return res.status(200).json({ ok: true });
      }
      if (path === '/monitor-history') {
        const rows = await sql`SELECT hist_long, hist24 FROM monitor_state WHERE user_id = ${user.uid}`;
        return res.status(200).json(rows[0] || { hist_long: [], hist24: [] });
      }
      const rows = await sql`SELECT enabled, status, last_tick, hist24, log FROM monitor_state WHERE user_id = ${user.uid}`;
      return res.status(200).json(rows[0] || { enabled: false });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
