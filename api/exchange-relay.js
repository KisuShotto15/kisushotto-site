// Relay de salida para el terminal del trade journal.
// Binance y Bitget bloquean las IPs de Cloudflare Workers (403), y desde aqui
// (Vercel sin1) Binance ya responde para el bot P2P. El worker firma cada lote
// con una llave derivada de JWT_SECRET, que ambos ya comparten.
//
// Solo reenvia a los hosts de la lista: no es un proxy abierto.

import crypto from 'node:crypto';

const HOSTS = new Set([
  'fapi.binance.com', 'api.binance.com', 'demo-fapi.binance.com', 'testnet.binance.vision',
  'api.bitget.com', 'nfs.faireconomy.media',
]);
const MAX_SKEW_MS = 30000;
const MAX_BATCH = 20;

function relayKey() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET no configurado');
  return crypto.createHmac('sha256', s).update('exchange-relay-v1').digest();
}

// Mismo texto que firma el worker (src/exchanges/common.js)
export function canonical(ts, reqs) {
  return `${ts}\n` + reqs.map(r => `${r.method}\n${r.url}\n${JSON.stringify(r.headers || {})}\n${r.body || ''}`).join('\n--\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  const { ts, reqs } = req.body || {};
  const sig = String(req.headers['x-relay-sig'] || '');
  if (!Array.isArray(reqs) || !reqs.length || reqs.length > MAX_BATCH) return res.status(400).json({ error: 'lote invalido' });
  if (!(Math.abs(Date.now() - ts) < MAX_SKEW_MS)) return res.status(401).json({ error: 'reloj' });

  let expected;
  try { expected = crypto.createHmac('sha256', relayKey()).update(canonical(ts, reqs)).digest('hex'); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: 'firma' });
  }

  const out = await Promise.all(reqs.map(async r => {
    let u;
    try { u = new URL(r.url); } catch { return { status: 400, body: 'url invalida' }; }
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return { status: 403, body: `host no permitido: ${u.hostname}` };
    try {
      const resp = await fetch(u, {
        method: r.method || 'GET', headers: r.headers || {}, body: r.body || undefined,
        signal: AbortSignal.timeout(8000),
      });
      return { status: resp.status, body: await resp.text() };
    } catch (e) {
      return { status: 599, body: `relay: ${e.message}` };
    }
  }));
  return res.status(200).json({ res: out });
}
