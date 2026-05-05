// Returns recent snapshots from Upstash within [from, to].
// Query: ?from=<ms>&to=<ms>&limit=<n>  (defaults: last 60 min, max 200)
// Auth (optional): X-Api-Secret like p2p-search proxy.

async function upstash(cmd, args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/${cmd}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`upstash ${cmd} ${r.status}`);
  return r.json();
}

async function upstashPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`upstash pipeline ${r.status}`);
  return r.json();
}

function expand(snap) {
  function mapAd(a) {
    return {
      price:    a.p,
      avail:    a.a,
      minVES:   a.n,
      maxVES:   a.x,
      merchant: a.m,
      orders:   a.o,
      comp:     a.c,
      badges:   a.b ? ['PRO'] : null,
      vipLevel: a.v
    };
  }
  return {
    ts: snap.ts,
    may:   (snap.may   || []).map(mapAd),
    small: (snap.small || []).map(mapAd),
    buy:   (snap.buy   || []).map(mapAd)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const secret = process.env.API_SECRET;
  if (secret && req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'upstash not configured' });
  }

  try {
    const now = Date.now();
    const to    = parseInt(req.query.to   || String(now), 10);
    const from  = parseInt(req.query.from || String(now - 60 * 60 * 1000), 10);
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);

    // ZRANGEBYSCORE returns timestamps ordered ASC
    const idx = await upstash('ZRANGEBYSCORE', ['snaps:idx', String(from), String(to), 'LIMIT', '0', String(limit)]);
    const tss = idx.result || [];
    if (!tss.length) return res.status(200).json({ snapshots: [] });

    // MGET via pipeline
    const cmds = tss.map(t => ['GET', `snap:${t}`]);
    const pipe = await upstashPipeline(cmds);
    const snaps = (pipe || [])
      .map(r => r && r.result ? r.result : null)
      .filter(Boolean)
      .map(s => { try { return expand(JSON.parse(s)); } catch { return null; } })
      .filter(Boolean);

    return res.status(200).json({ snapshots: snaps, count: snaps.length });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
