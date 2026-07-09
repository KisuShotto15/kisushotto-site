// Tasa USDT/VES publica: mediana del top-20 de merchants (SELL mayorista).
// Fuentes, en orden: (1) p2p_rate fresca (<10 min), escrita por el tick del monitor
// o el heartbeat del cliente; (2) busqueda publica en vivo (self-serve) que ademas
// refresca p2p_rate; (3) fila vieja como ultimo recurso. Dato de mercado publico:
// sin auth, CORS abierto. La consume el portfolio-tracker.
import { sql, ensureSchema } from './_lib/db.js';
import { publicSearch } from './_lib/binance.js';
import { topMedianRate } from './_lib/monitor.js';

const FRESH_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureSchema();
    const pay = String((req.query && req.query.pay) || 'BancoDeVenezuela');
    const rows = await sql`SELECT rate::float AS rate, n, updated_at FROM p2p_rate WHERE pay = ${pay}`;
    const fresh = rows.length && (Date.now() - new Date(rows[0].updated_at).getTime()) < FRESH_MS;

    if (!fresh) {
      // Self-serve: mismo fetch y criba que el monitor (mayorista 2M VES, verificados).
      try {
        const raw = await publicSearch({ transAmount: 2000000, pays: [pay], maxPages: 2, tradeType: 'SELL', verifiedOnly: true });
        const med = topMedianRate(raw, 20, true);
        if (med) {
          await sql`INSERT INTO p2p_rate (pay, rate, n, updated_at) VALUES (${pay}, ${med.rate}, ${med.n}, now())
            ON CONFLICT (pay) DO UPDATE SET rate = excluded.rate, n = excluded.n, updated_at = now()`.catch(() => {});
          res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
          return res.status(200).json({ rate: med.rate, merchants: med.n, pay, updatedAt: new Date().toISOString() });
        }
      } catch (e) { /* cae a la fila guardada (aunque este vieja) */ }
    }

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
