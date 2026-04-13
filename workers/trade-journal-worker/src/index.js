import { computeStats, groupByDimension, buildHeatmap } from './analytics.js';
import { generateInsights } from './insights.js';
import { fetchBybitFutures, fetchBybitSpot, fetchBinanceFutures, fetchBinanceSpot, parseBybitCSV } from './ingestion.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function auth(req, env) {
  return req.headers.get('Authorization') === `Bearer ${env.TOKEN || '151322'}`;
}

function uid() { return crypto.randomUUID(); }

function session(unixSec) {
  const h = new Date(unixSec * 1000).getUTCHours();
  if (h < 8)  return 'asia';
  if (h < 12) return 'london';
  if (h < 21) return 'ny';
  return 'other';
}

export default {
  async scheduled(event, env) {
    try { await runSync(env); } catch (e) { console.error('cron sync failed:', e); }
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!auth(request, env)) return json({ error: 'Unauthorized' }, 401);

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, '');
    const method = request.method;

    try {
      // ── Health ──────────────────────────────────────────────────────────────
      if (path === '/health') return json({ ok: true, ts: Date.now() });

      // ── Trades ──────────────────────────────────────────────────────────────
      if (path === '/trades' && method === 'GET')    return await listTrades(url, env);
      if (path === '/trades' && method === 'POST')   return await createTrade(request, env);
      const tradeMatch = path.match(/^\/trades\/([\w-]+)$/);
      if (tradeMatch) {
        const id = tradeMatch[1];
        if (method === 'GET')    return await getTrade(id, env);
        if (method === 'PUT')    return await updateTrade(id, request, env);
        if (method === 'DELETE') return await deleteTrade(id, env);
      }

      // ── Analytics ───────────────────────────────────────────────────────────
      if (path === '/analytics'              && method === 'GET') return await analytics(url, env);
      if (path === '/analytics/by-session'   && method === 'GET') return await byDimension('session',      env);
      if (path === '/analytics/by-symbol'    && method === 'GET') return await byDimension('symbol',       env);
      if (path === '/analytics/by-setup'     && method === 'GET') return await byDimension('setup_tag',    env);
      if (path === '/analytics/by-strategy'  && method === 'GET') return await byDimension('strategy_tag', env);
      if (path === '/analytics/heatmap'      && method === 'GET') return await heatmap(env);

      // ── Insights ────────────────────────────────────────────────────────────
      if (path === '/insights' && method === 'GET')  return await listInsights(env);
      if (path === '/insights/refresh' && method === 'POST') return await refreshInsights(env);

      // ── Strategies & Setups ─────────────────────────────────────────────────
      if (path === '/strategies') return await tagTable('strategies', request, env, method);
      if (path === '/setups')     return await tagTable('setups',     request, env, method);

      // ── Ingestion ───────────────────────────────────────────────────────────
      if (path === '/ingest/bybit'          && method === 'POST') return await ingestBybit(request, env, 'linear');
      if (path === '/ingest/bybit-inverse'  && method === 'POST') return await ingestBybit(request, env, 'inverse');
      if (path === '/ingest/bybit-spot'     && method === 'POST') return await ingestBybitSpot(request, env);
      if (path === '/ingest/binance'        && method === 'POST') return await ingestBinance(request, env);
      if (path === '/ingest/binance-spot'   && method === 'POST') return await ingestBinanceSpot(request, env);
      if (path === '/ingest/csv'            && method === 'POST') return await ingestCSV(request, env);

      // ── Sync config ─────────────────────────────────────────────────────────
      if (path === '/sync/config' && method === 'GET')  return await getSyncConfig(env);
      if (path === '/sync/config' && method === 'POST') return await setSyncConfig(request, env);
      if (path === '/sync/run'    && method === 'POST') return await runSync(env);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err.stack || err);
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
};

// ── Trades CRUD ───────────────────────────────────────────────────────────────

async function listTrades(url, env) {
  const p = url.searchParams;
  let sql = 'SELECT * FROM trades WHERE 1=1';
  const args = [];

  const filters = [
    ['symbol',       'symbol = ?',       v => v.toUpperCase()],
    ['side',         'side = ?',         v => v],
    ['setup',        'setup_tag = ?',    v => v],
    ['strategy',     'strategy_tag = ?', v => v],
    ['session',      'session = ?',      v => v],
    ['status',       'status = ?',       v => v],
    ['exchange',     'exchange = ?',     v => v],
    ['category',     'category = ?',     v => v],
    ['from',         'entry_time >= ?',  v => parseInt(v)],
    ['to',           'entry_time <= ?',  v => parseInt(v)],
  ];

  for (const [key, clause, transform] of filters) {
    const v = p.get(key);
    if (v) { sql += ` AND ${clause}`; args.push(transform(v)); }
  }

  sql += ' ORDER BY entry_time DESC';
  const limit  = Math.min(parseInt(p.get('limit') || 100), 1000);
  const offset = parseInt(p.get('page') || 0) * limit;
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ trades: results, page: +(p.get('page') || 0), limit });
}

async function createTrade(request, env) {
  const b   = await request.json();
  const now = Math.floor(Date.now() / 1000);
  const et  = b.entry_time || now;
  const status = b.exit_price != null ? 'closed' : (b.status || 'open');

  await env.DB.prepare(`
    INSERT OR IGNORE INTO trades
    (id, symbol, category, side, entry_price, exit_price, size, pnl, fees,
     entry_time, exit_time, strategy_tag, setup_tag, session, exec_type,
     notes, emotion, rule_score, status, exchange, exchange_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    b.id || uid(),
    (b.symbol || '').toUpperCase(), b.category || 'linear',
    b.side || 'long',
    parseFloat(b.entry_price) || 0,
    b.exit_price != null ? parseFloat(b.exit_price) : null,
    parseFloat(b.size) || 0,
    b.pnl != null ? parseFloat(b.pnl) : null,
    parseFloat(b.fees) || 0,
    et, b.exit_time || null,
    b.strategy_tag || null, b.setup_tag || null,
    b.session || session(et), b.exec_type || 'manual',
    b.notes || null, b.emotion || null,
    b.rule_score != null ? parseInt(b.rule_score) : null,
    status, b.exchange || 'bybit', b.exchange_id || null, now,
  ).run();

  return json({ ok: true }, 201);
}

async function getTrade(id, env) {
  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(id).first();
  if (!trade) return json({ error: 'Not found' }, 404);
  return json({ trade });
}

async function updateTrade(id, request, env) {
  const b = await request.json();
  const COLS = ['symbol','category','side','entry_price','exit_price','size','pnl','fees',
                'entry_time','exit_time','strategy_tag','setup_tag','session','exec_type',
                'notes','emotion','rule_score','status','exchange'];
  const updates = COLS.filter(c => b[c] !== undefined);
  if (!updates.length) return json({ error: 'Nothing to update' }, 400);
  if (b.exit_price != null && !updates.includes('status')) {
    updates.push('status'); b.status = 'closed';
  }
  const set    = updates.map(c => `${c} = ?`).join(', ');
  const values = [...updates.map(c => b[c]), id];
  await env.DB.prepare(`UPDATE trades SET ${set} WHERE id = ?`).bind(...values).run();
  const updated = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(id).first();
  return json({ trade: updated });
}

async function deleteTrade(id, env) {
  await env.DB.prepare('DELETE FROM trades WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ── Analytics ─────────────────────────────────────────────────────────────────

async function analytics(url, env) {
  const p  = url.searchParams;
  let sql  = "SELECT * FROM trades WHERE status = 'closed'";
  const args = [];
  if (p.get('from')) { sql += ' AND entry_time >= ?'; args.push(+p.get('from')); }
  if (p.get('to'))   { sql += ' AND entry_time <= ?'; args.push(+p.get('to')); }
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ stats: computeStats(results) });
}

async function byDimension(field, env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM trades WHERE status = 'closed'"
  ).all();
  return json({ data: groupByDimension(results, field) });
}

async function heatmap(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM trades WHERE status = 'closed'"
  ).all();
  return json({ heatmap: buildHeatmap(results) });
}

// ── Insights ──────────────────────────────────────────────────────────────────

async function listInsights(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM insights ORDER BY generated_at DESC LIMIT 100'
  ).all();
  return json({ insights: results });
}

async function refreshInsights(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM trades WHERE status = 'closed' ORDER BY entry_time"
  ).all();
  const fresh = generateInsights(results);
  await env.DB.prepare('DELETE FROM insights').run();
  for (const ins of fresh) {
    await env.DB.prepare(
      'INSERT INTO insights (id, type, title, description, severity, data, generated_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(uid(), ins.type, ins.title, ins.description, ins.severity, ins.data || null,
           Math.floor(Date.now() / 1000)).run();
  }
  return json({ refreshed: fresh.length });
}

// ── Strategies & Setups ───────────────────────────────────────────────────────

async function tagTable(table, request, env, method) {
  if (method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
    return json({ [table]: results });
  }
  if (method === 'POST') {
    const b  = await request.json();
    const id = uid();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ${table} (id, name, description, created_at) VALUES (?,?,?,?)`
    ).bind(id, b.name, b.description || null, Math.floor(Date.now() / 1000)).run();
    return json({ id, name: b.name }, 201);
  }
  return json({ error: 'Method not allowed' }, 405);
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

async function upsertTrades(trades, env) {
  const stmt = env.DB.prepare(`
    INSERT OR IGNORE INTO trades
    (id, symbol, category, side, entry_price, exit_price, size, pnl, fees,
     entry_time, exit_time, session, exec_type, status, exchange, exchange_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0;
  for (const t of trades) {
    const res = await stmt.bind(
      uid(), t.symbol, t.category || 'linear',
      t.side, t.entry_price, t.exit_price ?? null, t.size,
      t.pnl ?? null, t.fees ?? 0, t.entry_time, t.exit_time ?? null,
      t.session, t.exec_type || 'bot', t.status || 'closed',
      t.exchange, t.exchange_id ?? null,
      Math.floor(Date.now() / 1000),
    ).run();
    if (res.meta.changes > 0) inserted++;
  }
  return { total: trades.length, inserted, duplicates: trades.length - inserted };
}

async function ingestBybit(request, env, category) {
  const { apiKey, apiSecret, symbol } = await request.json();
  if (!apiKey || !apiSecret) return json({ error: 'apiKey + apiSecret required' }, 400);
  const trades = await fetchBybitFutures(apiKey, apiSecret, { category, symbol });
  return json(await upsertTrades(trades, env));
}

async function ingestBybitSpot(request, env) {
  const { apiKey, apiSecret, symbol } = await request.json();
  if (!apiKey || !apiSecret) return json({ error: 'apiKey + apiSecret required' }, 400);
  const trades = await fetchBybitSpot(apiKey, apiSecret, symbol);
  return json(await upsertTrades(trades, env));
}

async function ingestBinance(request, env) {
  const { apiKey, apiSecret, symbol } = await request.json();
  if (!apiKey || !apiSecret || !symbol) return json({ error: 'apiKey + apiSecret + symbol required' }, 400);
  const trades = await fetchBinanceFutures(apiKey, apiSecret, symbol);
  return json(await upsertTrades(trades, env));
}

async function ingestBinanceSpot(request, env) {
  const { apiKey, apiSecret, symbol } = await request.json();
  if (!apiKey || !apiSecret || !symbol) return json({ error: 'apiKey + apiSecret + symbol required' }, 400);
  const trades = await fetchBinanceSpot(apiKey, apiSecret, symbol);
  return json(await upsertTrades(trades, env));
}

async function ingestCSV(request, env) {
  const { csv } = await request.json();
  if (!csv) return json({ error: 'csv field required' }, 400);
  const trades = parseBybitCSV(csv);
  if (!trades.length) return json({ error: 'No se encontraron trades en el CSV. Verifica que sea el Transaction Log de Bybit con tipo Trade.' }, 400);
  return json(await upsertTrades(trades, env));
}

// ── Sync config ───────────────────────────────────────────────────────────────

async function getSyncConfig(env) {
  const row = await env.DB.prepare('SELECT id, exchange, last_sync, enabled FROM sync_configs WHERE id = ?').bind('bybit').first();
  return json({ config: row || null });
}

async function setSyncConfig(request, env) {
  const { apiKey, apiSecret, enabled = 1 } = await request.json();
  if (!apiKey || !apiSecret) return json({ error: 'apiKey + apiSecret required' }, 400);
  await env.DB.prepare(`
    INSERT INTO sync_configs (id, exchange, api_key, api_secret, enabled, updated_at)
    VALUES ('bybit', 'bybit', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, api_secret=excluded.api_secret,
      enabled=excluded.enabled, updated_at=excluded.updated_at
  `).bind(apiKey, apiSecret, enabled ? 1 : 0, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true });
}

async function runSync(env) {
  const cfg = await env.DB.prepare('SELECT * FROM sync_configs WHERE id = ? AND enabled = 1').bind('bybit').first();
  if (!cfg) return json({ skipped: true, reason: 'no config or disabled' });

  const since = cfg.last_sync > 0 ? cfg.last_sync * 1000 : 0;
  const [linear, inverse] = await Promise.all([
    fetchBybitFutures(cfg.api_key, cfg.api_secret, { category: 'linear',  since }),
    fetchBybitFutures(cfg.api_key, cfg.api_secret, { category: 'inverse', since }),
  ]);

  const all = [...linear, ...inverse];
  const result = await upsertTrades(all, env);
  await env.DB.prepare('UPDATE sync_configs SET last_sync = ? WHERE id = ?')
    .bind(Math.floor(Date.now() / 1000), 'bybit').run();

  return json({ ok: true, ...result, synced_at: Date.now() });
}
