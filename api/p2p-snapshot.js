// Cron-triggered: fetches P2P book and writes a compact snapshot to Upstash.
// Auth: X-Cron-Secret header must match process.env.CRON_SECRET.
// Env required: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, CRON_SECRET.

const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const SNAP_TTL_SEC = 86400;             // 24h
const PRUNE_OLDER_THAN_MS = 86400000;   // 24h

async function fetchTier(transAmount, tradeType, maxPages) {
  const pages = [];
  for (let i = 1; i <= maxPages; i++) {
    pages.push(fetch(BINANCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: 'USDT', fiat: 'VES', merchantCheck: false,
        page: i, rows: 20, tradeType, transAmount,
        payTypes: ['BancoDeVenezuela']
      })
    }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })));
  }
  const out = await Promise.all(pages);
  return out.flatMap(d => d.data || []);
}

function compact(raw) {
  return raw.map(item => ({
    p:  parseFloat(item.adv.price),
    a:  parseFloat(item.adv.tradableQuantity),
    n:  parseFloat(item.adv.minSingleTransAmount),
    x:  parseFloat(item.adv.maxSingleTransAmount),
    m:  item.advertiser.nickName,
    o:  item.advertiser.monthOrderCount,
    c:  Math.round((item.advertiser.monthFinishRate || 0) * 100),
    b:  (item.advertiser.badges && item.advertiser.badges.length) ? 1 : 0,
    v:  item.advertiser.vipLevel
  })).filter(a => a.b === 1);
}

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const secret = process.env.CRON_SECRET;
  const provided = req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'upstash not configured' });
  }

  try {
    // Small tiers: fetch at 3 amounts and merge unique ads by merchant
    // so the snapshot covers the full range the user may configure (30k–300k VES).
    const [mayRaw, buyRaw, sm1, sm2, sm3] = await Promise.all([
      fetchTier(2000000, 'SELL', 2),
      fetchTier(2000000, 'BUY',  2),
      fetchTier(40000,   'SELL', 3),
      fetchTier(100000,  'SELL', 2),
      fetchTier(300000,  'SELL', 2)
    ]);
    const smallMerged = new Map();
    for (const item of [...sm1, ...sm2, ...sm3]) {
      const key = item.advertiser.nickName;
      if (!smallMerged.has(key)) smallMerged.set(key, item);
    }
    const smallRaw = [...smallMerged.values()];

    const ts = Date.now();
    const snap = {
      ts,
      may:   compact(mayRaw),
      small: compact(smallRaw),
      buy:   compact(buyRaw)
    };
    const payload = JSON.stringify(snap);

    // SETEX snap:<ts>  +  ZADD snaps:idx ts ts  (in pipeline)
    await upstashPipeline([
      ['SETEX', `snap:${ts}`, String(SNAP_TTL_SEC), payload],
      ['ZADD',  'snaps:idx', String(ts), String(ts)]
    ]);

    // Prune old index entries occasionally (every ~30 ticks)
    if (Math.random() < 0.03) {
      const cutoff = ts - PRUNE_OLDER_THAN_MS;
      await upstash('ZREMRANGEBYSCORE', ['snaps:idx', '-inf', String(cutoff)]);
    }

    return res.status(200).json({
      ok: true, ts,
      counts: { may: snap.may.length, small: snap.small.length, buy: snap.buy.length }
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}
