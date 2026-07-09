// Tasa USDT/VES publica: mediana del top-20 de merchants (SELL mayorista) que el
// monitor ya fetchea 24/7 — este endpoint solo lee la ultima guardada en p2p_rate.
// Dato de mercado publico: sin auth, CORS abierto. La consume el portfolio-tracker.
import { sql, ensureSchema } from './_lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const pay = String((req.query && req.query.pay) || 'BancoDeVenezuela');
    const rows = await sql`SELECT rate::float AS rate, n, updated_at FROM p2p_rate WHERE pay = ${pay}`;
    if (!rows.length) return res.status(404).json({ error: 'no rate yet' });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({
      rate: rows[0].rate,
      merchants: rows[0].n,
      pay,
      updatedAt: rows[0].updated_at,
    });
  } catch (e) {
    return res.status(503).json({ error: 'rate unavailable' });
  }
}
