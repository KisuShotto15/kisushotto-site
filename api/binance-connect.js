import crypto from 'node:crypto';
import { cors, requireUser } from './_lib/auth.js';
import { sql, ensureSchema } from './_lib/db.js';
import { encrypt } from './_lib/crypto.js';

const BINANCE = 'https://api.binance.com';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let user;
  try { user = requireUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  const { apiKey, apiSecret, label } = req.body || {};
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey y apiSecret requeridos' });

  // Validar las llaves: llamada C2C firmada antes de guardar nada.
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', apiSecret).update(`timestamp=${ts}`).digest('hex');
  let data;
  try {
    const r = await fetch(`${BINANCE}/sapi/v1/c2c/ads/listWithPagination?timestamp=${ts}&signature=${sig}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/json', 'clientType': 'web' },
      body: JSON.stringify({ page: 1, rows: 1, tradeType: 'BUY', asset: 'USDT', fiatUnit: 'VES' }),
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok || (data.code && data.code !== '000000')) {
      return res.status(400).json({ error: 'Llaves invalidas o sin permiso C2C', detail: data.msg || data.code || r.status });
    }
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo validar con Binance: ' + e.message });
  }

  try {
    await ensureSchema();
    const ek = encrypt(apiKey), es = encrypt(apiSecret);
    await sql`INSERT INTO binance_creds
      (user_id, enc_key, iv_key, tag_key, enc_secret, iv_secret, tag_secret, label)
      VALUES (${user.uid}, ${ek.ct}, ${ek.iv}, ${ek.tag}, ${es.ct}, ${es.iv}, ${es.tag}, ${label || null})
      ON CONFLICT (user_id) DO UPDATE SET
        enc_key = EXCLUDED.enc_key, iv_key = EXCLUDED.iv_key, tag_key = EXCLUDED.tag_key,
        enc_secret = EXCLUDED.enc_secret, iv_secret = EXCLUDED.iv_secret, tag_secret = EXCLUDED.tag_secret,
        label = EXCLUDED.label, created_at = now()`;
    return res.status(200).json({ ok: true, label: label || 'Binance' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
