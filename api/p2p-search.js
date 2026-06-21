import { requireAllowedUser } from './_lib/auth.js';

// ── Rate limit configurable por env (0 / sin setear = desactivado) ──
const RL_MAX    = parseInt(process.env.RATE_LIMIT_MAX || '0', 10);
const RL_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const rlHits = new Map(); // ip -> { count, resetAt }

function rateLimited(req) {
  if (!RL_MAX) return null; // desactivado
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .split(',')[0].trim();
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW }; rlHits.set(ip, e); }
  e.count++;
  if (rlHits.size > 5000) { // poda ocasional para no crecer sin limite
    for (const [k, v] of rlHits) if (now >= v.resetAt) rlHits.delete(k);
  }
  return e.count > RL_MAX ? Math.ceil((e.resetAt - now) / 1000) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const retryAfter = rateLimited(req);
  if (retryAfter !== null) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
  }

  try { requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

  // Lote: { queries: [body1, body2, ...] } → fan-out a Binance, 1 sola invocacion Vercel
  const queries = req.body && req.body.queries;
  if (Array.isArray(queries)) {
    const settled = await Promise.allSettled(queries.map(q =>
      fetch(BINANCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
      }).then(r => r.json())
    ));
    return res.status(200).json({
      results: settled.map(s => s.status === 'fulfilled' ? s.value : { error: String(s.reason) })
    });
  }

  // Body unico (compat)
  const r = await fetch(BINANCE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  const data = await r.json();
  res.status(r.ok ? 200 : 502).json(data);
}
