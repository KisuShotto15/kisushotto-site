import { requireAllowedUser } from './_lib/auth.js';
import { rateLimit, clientIp } from './_lib/ratelimit.js';
import { hasActiveSub } from './_lib/subscriptions.js';

// ── Rate limit configurable por env (0 / sin setear = desactivado) ──
const RL_MAX    = parseInt(process.env.RATE_LIMIT_MAX || '0', 10);
const RL_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

function rateLimited(req) {
  if (!RL_MAX) return null; // desactivado
  return rateLimit('search:' + clientIp(req), RL_MAX, RL_WINDOW);
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

  let user;
  try { user = requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  // La puerta del cliente se puede saltar llamando aca directamente: sin prueba
  // vigente ni periodo pagado no se sirve el libro.
  if (!(await hasActiveSub(user.uid))) {
    return res.status(402).json({ error: 'Suscripcion requerida' });
  }

  const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

  // Recorta cada anuncio a los campos que usa la app (misma forma anidada, ~95% menos
  // bytes). Fast Origin Transfer cuenta cada byte que la funcion devuelve al CDN.
  function slimItem(it) {
    if (!it || !it.adv || !it.advertiser) return it;
    return {
      adv: {
        advNo: it.adv.advNo,
        price: it.adv.price,
        minSingleTransAmount: it.adv.minSingleTransAmount,
        maxSingleTransAmount: it.adv.maxSingleTransAmount,
        tradableQuantity: it.adv.tradableQuantity,
        tradeMethods: (it.adv.tradeMethods || []).map(m => ({ identifier: m && m.identifier })),
      },
      advertiser: {
        nickName: it.advertiser.nickName,
        monthOrderCount: it.advertiser.monthOrderCount,
        monthFinishRate: it.advertiser.monthFinishRate,
        badges: it.advertiser.badges,
        vipLevel: it.advertiser.vipLevel,
      },
    };
  }
  function slimResp(d) {
    return (d && Array.isArray(d.data)) ? { ...d, data: d.data.map(slimItem) } : d;
  }

  // Lote: { queries: [body1, body2, ...] } → fan-out a Binance, 1 sola invocacion Vercel
  const queries = req.body && req.body.queries;
  if (Array.isArray(queries)) {
    // Timeout por query: sin el, una conexion colgada con Binance retiene la
    // invocacion hasta maxDuration mucho despues de que el cliente abortara.
    const settled = await Promise.allSettled(queries.map(q =>
      fetch(BINANCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
        signal: AbortSignal.timeout(7000),
      }).then(r => r.json())
    ));
    return res.status(200).json({
      results: settled.map(s => s.status === 'fulfilled' ? slimResp(s.value) : { error: String(s.reason) })
    });
  }

  // Body unico (compat)
  const r = await fetch(BINANCE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
  const data = await r.json();
  res.status(r.ok ? 200 : 502).json(slimResp(data));
}
