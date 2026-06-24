// Ejecutor server-side del bot. Lo dispara el Durable Object de Cloudflare cada ~18s.
// Protegido por secreto compartido (x-bot-secret). NO usa JWT.
import { sql, ensureSchema } from './_lib/db.js';
import { decrypt } from './_lib/crypto.js';
import { getMyAds, updateAdPrice, updateMinLimit, publicSearch } from './_lib/binance.js';
import { computeReprice, adPayTypes } from './_lib/reprice.js';

export const config = { maxDuration: 60 };

const MAX_USERS = 25; // tope por tick (secuencial)

function pushLog(log, msg, level) {
  const arr = Array.isArray(log) ? log.slice(-19) : [];
  arr.push({ ts: Date.now(), msg, level: level || 'info' });
  return arr;
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
    log = pushLog(log, '🛑 Fondos insuficientes (<100 USDT) — bot detenido', 'error');
    return { enabled: false, status: 'Detenido: fondos bajos', log, adNumber: ad.advNo || ad.adNumber, currentPrice, lastReprice };
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

  const marketRaw = await publicSearch({ transAmount: myMin + threshold, pays, maxPages: 2, tradeType: 'SELL' });
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.BOT_TICK_SECRET || req.headers['x-bot-secret'] !== process.env.BOT_TICK_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    await ensureSchema();
    const rows = await sql`
      SELECT b.user_id, b.enabled, b.config, b.ad_number, b.current_price, b.last_reprice, b.log,
             c.enc_key, c.iv_key, c.tag_key, c.enc_secret, c.iv_secret, c.tag_secret
      FROM bot_state b
      JOIN binance_creds c ON c.user_id = b.user_id
      WHERE b.enabled = true
      LIMIT ${MAX_USERS}`;

    let ticked = 0;
    for (const row of rows) {
      let out;
      try {
        out = await tickUser(row);
      } catch (e) {
        out = { enabled: row.enabled, status: 'Error: ' + e.message, log: pushLog(row.log, 'Error: ' + e.message, 'error'),
                adNumber: row.ad_number, currentPrice: row.current_price, lastReprice: row.last_reprice };
      }
      await sql`
        UPDATE bot_state SET
          enabled = ${out.enabled},
          status = ${out.status || null},
          log = ${JSON.stringify(out.log || [])}::jsonb,
          ad_number = ${out.adNumber || null},
          current_price = ${out.currentPrice != null ? out.currentPrice : null},
          last_reprice = ${out.lastReprice || null},
          last_tick = now(),
          updated_at = now()
        WHERE user_id = ${row.user_id}`;
      ticked++;
    }
    return res.status(200).json({ ok: true, ticked });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
