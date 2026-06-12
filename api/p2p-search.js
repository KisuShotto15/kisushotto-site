export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.API_SECRET;
  if (secret && req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
