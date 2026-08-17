import { computeStats, groupByDimension, buildHeatmap, buildWeeklyReview, riskOf } from './analytics.js';
import { generateInsights } from './insights.js';
import { fetchBybitFutures, fetchBybitSpot, fetchBinanceFutures, fetchBinanceSpot, fetchBybitPositions, fetchBybitBalance, parseBybitCSV } from './ingestion.js';

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

// ── Autenticacion ─────────────────────────────────────────────────────────────
// Se aceptan dos credenciales:
//  - JWT de usuario, el mismo que emite /api/auth/login del resto del sitio.
//    Se verifica aca con el secreto compartido, sin llamar a Vercel.
//  - TOKEN de servicio, para el CLI y pruebas. Es un secret, no va en el bundle.

function eq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToB64url(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// HS256, igual que api/_lib/crypto.js pero con WebCrypto
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
  if (!eq(sig, bytesToB64url(mac))) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); }
  catch { return null; }

  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function isAllowed(email, list) {
  const allowed = String(list || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return false;  // sin lista configurada = no pasa nadie
  return allowed.includes(String(email || '').trim().toLowerCase());
}

const AUTH_BASE = 'https://kisushotto-site.vercel.app';
const REVOKE_TTL = 300;  // 5 min: una revocacion tarda como mucho eso en aplicar

// La firma y el exp se comprueban aca, pero la revocacion vive en Neon y solo
// Vercel la ve. Se consulta con cache para no pagar el viaje en cada peticion.
async function sessionRevoked(tok, ctx) {
  const key = new Request(`https://tj-auth.local/${await sha256hex(tok)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return (await hit.json()).revoked;

  let revoked = false;
  try {
    const res = await fetch(`${AUTH_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${tok}` },
    });
    revoked = res.status === 401;
  } catch {
    // Si Vercel no responde no se cierra el paso: la firma y el exp ya se
    // validaron localmente. Se prefiere disponibilidad ante un fallo de red.
    return false;
  }

  const put = cache.put(key, new Response(JSON.stringify({ revoked }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${REVOKE_TTL}` },
  }));
  if (ctx) ctx.waitUntil(put); else await put;
  return revoked;
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function auth(req, env, ctx) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return false;
  const tok = m[1];

  if (env.TOKEN && eq(tok, env.TOKEN)) return true;

  if (env.JWT_SECRET) {
    const payload = await verifyJWT(tok, env.JWT_SECRET);
    if (!payload || !isAllowed(payload.email, env.ALLOWED_EMAILS)) return false;
    return !(await sessionRevoked(tok, ctx));
  }
  return false;
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
    // El snapshot va primero: guarda el stop de lo que sigue abierto antes de
    // que el sync traiga esos mismos trades ya cerrados.
    try { await snapshotPositions(env); } catch (e) { console.error('cron snapshot failed:', e); }
    // El sync completo es pesado, solo cada 15 min
    if (event.cron !== '* * * * *') {
      try { await runSync(env); }         catch (e) { console.error('cron sync failed:', e); }
      try { await refreshBalance(env); }  catch (e) { console.error('cron balance failed:', e); }
    }
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!(await auth(request, env, ctx))) return json({ error: 'Unauthorized' }, 401);

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, '');
    const method = request.method;

    try {
      // ── Health ──────────────────────────────────────────────────────────────
      if (path === '/health') return json({ ok: true, ts: Date.now() });
      if (path === '/health/audit') return await audit(env);
      if (path === '/config' && method === 'GET')  return await getConfig(env);
      if (path === '/config' && method === 'POST') return await setConfig(request, env);

      // ── Trades ──────────────────────────────────────────────────────────────
      if (path === '/trades' && method === 'GET')    return await listTrades(url, env);
      if (path === '/trades' && method === 'POST')   return await createTrade(request, env);
      if (path === '/trades/bulk-tag' && method === 'POST') return await bulkTag(request, env);
      if (path === '/trades/export'   && method === 'GET')  return await exportCSV(url, env);
      const tradeMatch = path.match(/^\/trades\/([\w-]+)$/);
      if (tradeMatch) {
        const id = tradeMatch[1];
        if (method === 'GET')    return await getTrade(id, env);
        if (method === 'PUT')    return await updateTrade(id, request, env);
        if (method === 'DELETE') return await deleteTrade(id, env);
      }

      // ── Posiciones en vivo ──────────────────────────────────────────────────
      if (path === '/positions/live' && method === 'GET')  return await livePositions(env);
      if (path === '/positions/plan' && method === 'GET')  return await listPlans(env);
      if (path === '/positions/plan' && method === 'POST') return await savePlan(request, env);

      // ── Analytics ───────────────────────────────────────────────────────────
      if (path === '/analytics'              && method === 'GET') return await analytics(url, env);
      if (path === '/analytics/by-session'   && method === 'GET') return await byDimension('session', env, url);
      if (path === '/analytics/by-symbol'    && method === 'GET') return await byDimension('symbol', env, url);
      if (path === '/analytics/by-setup'     && method === 'GET') return await byDimension('setup_tag', env, url);
      if (path === '/analytics/by-strategy'  && method === 'GET') return await byDimension('strategy_tag', env, url);
      if (path === '/analytics/heatmap'      && method === 'GET') return await heatmap(env);
      if (path === '/analytics/weekly'       && method === 'GET') return await weekly(url, env);

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
      if (path === '/sync/run'    && method === 'POST') return await runSync(env, url.searchParams);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err.stack || err);
      return json({ error: err.message || 'Internal error' }, 500);
    }
  },
};

// Chequeo de coherencia de los datos. Cada bandera corresponde a un bug real
// que ya ocurrio; si alguna sube, algo se rompio en la ingesta otra vez.
async function audit(env) {
  const q = sql => env.DB.prepare(sql).first();

  const [general, dup, spot] = await Promise.all([
    q(`SELECT COUNT(*) total,
              SUM(entry_price <= 0 OR size <= 0) precio_o_size_invalido,
              SUM(exit_time IS NOT NULL AND exit_time < entry_time) salida_antes_de_entrada,
              SUM(fees < 0) fees_negativos,
              SUM(category IN ('linear','inverse') AND exit_price = entry_price AND ABS(COALESCE(pnl,0)) > entry_price*size*0.01) ganancia_sin_movimiento,
              SUM(ABS(fees - entry_price*size*0.00055) < 0.0000001) fees_estimados
       FROM trades WHERE status = 'closed'`),
    q(`SELECT COUNT(*) grupos FROM (
         SELECT 1 FROM trades WHERE status='closed'
         GROUP BY symbol, side, entry_time, ROUND(COALESCE(pnl,0),8), size HAVING COUNT(*) > 1)`),
    q(`SELECT SUM(pnl IS NOT NULL) spot_con_pnl, COUNT(*) spot_total
       FROM trades WHERE category = 'spot' AND status = 'closed'`),
  ]);

  const flags = {
    ...general,
    duplicados: dup.grupos,
    spot_con_pnl: spot.spot_con_pnl || 0,
    spot_total: spot.spot_total || 0,
  };

  // ok = ninguna bandera encendida (los fees estimados son solo un aviso)
  const problemas = ['precio_o_size_invalido','salida_antes_de_entrada','fees_negativos',
                     'ganancia_sin_movimiento','duplicados'].filter(k => (flags[k] || 0) > 0);

  return json({ ok: problemas.length === 0, problemas, flags });
}

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
  const stop = b.stop_price != null ? parseFloat(b.stop_price) : null;
  const risk = b.risk_usd != null
    ? parseFloat(b.risk_usd)
    : (stop > 0 && b.entry_price > 0 && b.size > 0
        ? Math.abs(parseFloat(b.entry_price) - stop) * parseFloat(b.size)
        : null);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO trades
    (id, symbol, category, side, entry_price, exit_price, size, pnl, fees,
     entry_time, exit_time, strategy_tag, setup_tag, session, exec_type,
     notes, emotion, rule_score, status, exchange, exchange_id, created_at,
     stop_price, risk_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    stop, risk,
  ).run();

  return json({ ok: true }, 201);
}

// Etiquetar varios trades de una en vez de abrirlos uno por uno.
async function bulkTag(request, env) {
  const { ids, setup_tag, strategy_tag } = await request.json();
  if (!Array.isArray(ids) || !ids.length) return json({ error: 'ids required' }, 400);
  if (setup_tag === undefined && strategy_tag === undefined) {
    return json({ error: 'setup_tag o strategy_tag required' }, 400);
  }

  const sets = [];
  const args = [];
  if (setup_tag    !== undefined) { sets.push('setup_tag = ?');    args.push(setup_tag    || null); }
  if (strategy_tag !== undefined) { sets.push('strategy_tag = ?'); args.push(strategy_tag || null); }

  const holes = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `UPDATE trades SET ${sets.join(', ')} WHERE id IN (${holes})`
  ).bind(...args, ...ids).run();

  return json({ ok: true, updated: res.meta.changes });
}

const CSV_COLS = ['id','symbol','category','side','entry_price','exit_price','stop_price','size',
                  'pnl','risk_usd','fees','entry_time','exit_time','strategy_tag','setup_tag',
                  'session','exec_type','emotion','rule_score','status','exchange','notes'];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCSV(url, env) {
  const p = url.searchParams;
  let sql = 'SELECT * FROM trades WHERE 1=1';
  const args = [];
  if (p.get('from')) { sql += ' AND entry_time >= ?'; args.push(+p.get('from')); }
  if (p.get('to'))   { sql += ' AND entry_time <= ?'; args.push(+p.get('to')); }
  sql += ' ORDER BY entry_time DESC';

  const { results } = await env.DB.prepare(sql).bind(...args).all();
  const rows = results.map(t => {
    const risk = riskOf(t);
    return [...CSV_COLS.map(c => csvCell(t[c])), csvCell(risk && t.pnl != null ? (t.pnl / risk).toFixed(3) : '')].join(',');
  });

  const csv = [[...CSV_COLS, 'r_multiple'].join(','), ...rows].join('\n');
  return new Response(csv, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="trades-${new Date().toISOString().slice(0, 10)}.csv"`,
      ...CORS,
    },
  });
}

async function getTrade(id, env) {
  const trade = await env.DB.prepare('SELECT * FROM trades WHERE id = ?').bind(id).first();
  if (!trade) return json({ error: 'Not found' }, 404);
  return json({ trade });
}

const EDITABLE_COLS = ['symbol','category','side','entry_price','exit_price','size','pnl','fees',
                       'entry_time','exit_time','strategy_tag','setup_tag','session','exec_type',
                       'notes','emotion','rule_score','status','exchange',
                       'stop_price','risk_usd','screenshots','stop_source'];

async function updateTrade(id, request, env) {
  const b = await request.json();
  const updates = EDITABLE_COLS.filter(c => b[c] !== undefined);
  if (!updates.length) return json({ error: 'Nothing to update' }, 400);
  if (b.exit_price != null && !updates.includes('status')) {
    updates.push('status'); b.status = 'closed';
  }

  // Si mandan un stop y no un riesgo explicito, el riesgo sale de |entrada - stop| * size
  if (b.stop_price !== undefined && b.risk_usd === undefined) {
    const cur   = await env.DB.prepare('SELECT entry_price, size FROM trades WHERE id = ?').bind(id).first();
    const entry = b.entry_price ?? cur?.entry_price;
    const size  = b.size ?? cur?.size;
    const risk  = b.stop_price > 0 && entry > 0 && size > 0
      ? Math.abs(entry - b.stop_price) * size
      : null;
    b.risk_usd = risk;
    updates.push('risk_usd');
    b.stop_source = b.stop_price != null ? 'manual' : null;
    updates.push('stop_source');
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

// ── Posiciones en vivo ────────────────────────────────────────────────────────
// Lee de Bybit directo (no de D1) y cachea 5s en el edge para que varias
// pestañas polleando no multipliquen las llamadas al exchange.

// Se sirve el espejo de D1, nunca se llama a Bybit aca: el worker corre en el
// colo mas cercano a quien pide y desde varios paises CloudFront responde 403.
// El cron es el unico que habla con Bybit, cada minuto.
async function livePositions(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM live_positions ORDER BY position_value DESC'
  ).all();

  const updatedAt = results.length ? Math.max(...results.map(p => p.updated_at)) : null;
  const conf = await env.DB.prepare('SELECT legacy_symbols FROM journal_config WHERE id = ?').bind('main').first();

  // Capital inmovilizado de la etapa anterior: se muestra pero no cuenta como
  // resultado de la etapa actual. Va por simbolo declarado, no por fecha.
  const legacy = new Set(String(conf?.legacy_symbols || '')
    .split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean));
  for (const p of results) p.legacy = legacy.has(p.symbol.toUpperCase()) ? 1 : 0;

  // No se pueden sumar monedas distintas: inverse paga en ETH/BTC, linear en USDT
  const byCoin = {};
  for (const p of results) {
    if (p.legacy) continue;
    const c = p.settle_coin || 'USDT';
    byCoin[c] = (byCoin[c] || 0) + (p.unrealized_pnl || 0);
  }

  return json({
    positions:        results,
    errors:           [],
    totals_by_coin:   byCoin,
    total_unrealized: (byCoin.USDT || 0) + (byCoin.USDC || 0),
    ts:               updatedAt ? updatedAt * 1000 : Date.now(),
    age_seconds:      updatedAt ? Math.floor(Date.now() / 1000) - updatedAt : null,
    source:           'cron',
  });
}

// ── Plan pre-trade ────────────────────────────────────────────────────────────

async function listPlans(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM trade_plans WHERE applied = 0 ORDER BY created_at DESC LIMIT 100'
  ).all();
  return json({ plans: results });
}

async function savePlan(request, env) {
  const b = await request.json();
  if (!b.symbol || !b.side || !b.opened_at) {
    return json({ error: 'symbol + side + opened_at required' }, 400);
  }
  await env.DB.prepare(`
    INSERT INTO trade_plans (symbol, side, opened_at, setup_tag, strategy_tag, rule_score, checklist, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, side, opened_at) DO UPDATE SET
      setup_tag    = excluded.setup_tag,
      strategy_tag = excluded.strategy_tag,
      rule_score   = excluded.rule_score,
      checklist    = excluded.checklist,
      notes        = excluded.notes
  `).bind(
    b.symbol.toUpperCase(), b.side, parseInt(b.opened_at),
    b.setup_tag || null, b.strategy_tag || null,
    b.rule_score != null ? parseInt(b.rule_score) : null,
    b.checklist ? JSON.stringify(b.checklist) : null,
    b.notes || null, Math.floor(Date.now() / 1000),
  ).run();
  return json({ ok: true });
}

// Pega los planes a los trades ya cerrados. Solo rellena lo que este vacio:
// si el usuario ya edito el trade a mano, gana lo que puso el usuario.
async function attachPlans(env) {
  const { results: plans } = await env.DB.prepare(
    'SELECT * FROM trade_plans WHERE applied = 0'
  ).all();
  if (!plans.length) return 0;

  let applied = 0;
  for (const p of plans) {
    const res = await env.DB.prepare(`
      UPDATE trades SET
        setup_tag    = COALESCE(setup_tag,    ?),
        strategy_tag = COALESCE(strategy_tag, ?),
        rule_score   = COALESCE(rule_score,   ?),
        notes        = COALESCE(notes,        ?)
      WHERE status = 'closed' AND symbol = ? AND side = ?
        AND ? BETWEEN entry_time - 900 AND COALESCE(exit_time, entry_time) + 900
    `).bind(
      p.setup_tag, p.strategy_tag, p.rule_score, p.notes,
      p.symbol, p.side,
      // created_at, no opened_at: el createdTime de Bybit es la primera vez que
      // existio una posicion en ese simbolo, no la apertura de esta. El plan en
      // cambio se guarda con la posicion viva, asi que cae dentro del trade.
      p.created_at,
    ).run();

    if (res.meta.changes > 0) {
      await env.DB.prepare(
        'UPDATE trade_plans SET applied = 1 WHERE symbol = ? AND side = ? AND opened_at = ?'
      ).bind(p.symbol, p.side, p.opened_at).run();
      applied++;
    }
  }
  return applied;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

async function getConfig(env) {
  const row = await env.DB.prepare('SELECT * FROM journal_config WHERE id = ?').bind('main').first();
  return json({ config: row || null });
}

async function setConfig(request, env) {
  const b = await request.json();
  await env.DB.prepare(`
    INSERT INTO journal_config (id, start_capital, start_date, updated_at)
    VALUES ('main', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      start_capital = excluded.start_capital,
      start_date    = excluded.start_date,
      updated_at    = excluded.updated_at
  `).bind(
    b.start_capital != null ? parseFloat(b.start_capital) : null,
    b.start_date != null ? parseInt(b.start_date) : null,
    Math.floor(Date.now() / 1000),
  ).run();
  if (b.legacy_symbols !== undefined) {
    await env.DB.prepare('UPDATE journal_config SET legacy_symbols = ? WHERE id = ?')
      .bind(b.legacy_symbols || null, 'main').run();
  }
  return json({ ok: true });
}

async function refreshBalance(env) {
  const cfg = await env.DB.prepare('SELECT * FROM sync_configs WHERE id = ? AND enabled = 1').bind('bybit').first();
  if (!cfg) return null;
  const bal = await fetchBybitBalance(cfg.api_key, cfg.api_secret);
  if (!bal) return null;
  await env.DB.prepare(`
    INSERT INTO account_balance (id, total_equity, wallet_balance, coin, updated_at)
    VALUES ('bybit', ?, ?, 'USDT', ?)
    ON CONFLICT(id) DO UPDATE SET
      total_equity = excluded.total_equity,
      wallet_balance = excluded.wallet_balance,
      updated_at = excluded.updated_at
  `).bind(bal.total_equity, bal.wallet_balance, Math.floor(Date.now() / 1000)).run();
  return bal;
}

async function analytics(url, env) {
  const p  = url.searchParams;
  let sql  = "SELECT * FROM trades WHERE status = 'closed'";
  const args = [];
  if (p.get('from')) { sql += ' AND entry_time >= ?'; args.push(+p.get('from')); }
  if (p.get('to'))   { sql += ' AND entry_time <= ?'; args.push(+p.get('to')); }

  const [{ results }, bal, conf] = await Promise.all([
    env.DB.prepare(sql).bind(...args).all(),
    env.DB.prepare('SELECT total_equity FROM account_balance WHERE id = ?').bind('bybit').first(),
    env.DB.prepare('SELECT * FROM journal_config WHERE id = ?').bind('main').first(),
  ]);

  return json({
    stats: computeStats(results, {
      equityNow:    bal?.total_equity ?? null,
      // El capital de $1000 solo describe la etapa nueva: aplicarlo a los
      // trades viejos seria medirlos contra un capital que no existia entonces
      startCapital: (conf?.start_date && p.get('from') && +p.get('from') >= conf.start_date)
                      ? conf.start_capital : null,
    }),
    equity: bal?.total_equity ?? null,
    config: conf || null,
  });
}

async function byDimension(field, env, url) {
  // Respetar from/to: el sidebar dice "ESTE MES" y antes mostraba todo el historial
  let sql = "SELECT * FROM trades WHERE status = 'closed'";
  const args = [];
  const p = url?.searchParams;
  if (p?.get('from')) { sql += ' AND entry_time >= ?'; args.push(+p.get('from')); }
  if (p?.get('to'))   { sql += ' AND entry_time <= ?'; args.push(+p.get('to')); }

  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ data: groupByDimension(results, field) });
}

async function weekly(url, env) {
  const weeks = Math.min(parseInt(url.searchParams.get('weeks') || 8), 52);
  const { results } = await env.DB.prepare(
    "SELECT * FROM trades WHERE status = 'closed' ORDER BY entry_time DESC LIMIT 2000"
  ).all();
  return json({ weeks: buildWeeklyReview(results, weeks) });
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
  if (!trades.length) return { total: 0, inserted: 0, updated: 0 };

  // ON CONFLICT DO UPDATE (no OR IGNORE) para que un re-sync corrija datos viejos.
  // Solo pisa campos que vienen del exchange: notas, tags y emocion son del usuario.
  const stmt = env.DB.prepare(`
    INSERT INTO trades
    (id, symbol, category, side, entry_price, exit_price, size, pnl, fees,
     entry_time, exit_time, session, exec_type, status, exchange, exchange_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(exchange, exchange_id) WHERE exchange_id IS NOT NULL DO UPDATE SET
      entry_price = excluded.entry_price,
      exit_price  = excluded.exit_price,
      size        = excluded.size,
      pnl         = excluded.pnl,
      fees        = excluded.fees,
      exit_time   = excluded.exit_time,
      status      = excluded.status
  `);

  const before = await env.DB.prepare('SELECT COUNT(*) AS c FROM trades').first();
  const now    = Math.floor(Date.now() / 1000);

  const rows = trades.map(t => stmt.bind(
    uid(), t.symbol, t.category || 'linear',
    t.side, t.entry_price, t.exit_price ?? null, t.size,
    t.pnl ?? null, t.fees ?? 0, t.entry_time, t.exit_time ?? null,
    t.session, t.exec_type || 'bot', t.status || 'closed',
    t.exchange, t.exchange_id ?? null, now,
  ));

  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50));
  }

  const after    = await env.DB.prepare('SELECT COUNT(*) AS c FROM trades').first();
  const inserted = after.c - before.c;
  return { total: trades.length, inserted, updated: trades.length - inserted, duplicates: trades.length - inserted };
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

// Guarda el stop/TP de las posiciones abiertas. Bybit no lo devuelve una vez
// cerradas, asi que sin esto no hay forma de calcular la R automaticamente.
async function snapshotPositions(env) {
  const cfg = await env.DB.prepare('SELECT * FROM sync_configs WHERE id = ? AND enabled = 1').bind('bybit').first();
  if (!cfg) return { skipped: true };

  const { positions } = await fetchBybitPositions(cfg.api_key, cfg.api_secret);
  const now = Math.floor(Date.now() / 1000);

  if (!positions.length) {
    // Sin posiciones abiertas el espejo tiene que quedar vacio, no congelado
    await env.DB.prepare('DELETE FROM live_positions').run();
    return { saved: 0 };
  }

  const stmt = env.DB.prepare(`
    INSERT INTO position_snapshots (symbol, side, opened_at, entry_price, stop_price, take_profit, size, seen_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, side, opened_at) DO UPDATE SET
      entry_price = excluded.entry_price,
      stop_price  = COALESCE(excluded.stop_price, position_snapshots.stop_price),
      take_profit = COALESCE(excluded.take_profit, position_snapshots.take_profit),
      size        = MAX(excluded.size, position_snapshots.size),
      seen_at     = excluded.seen_at
  `);

  await env.DB.batch(positions.map(p => stmt.bind(
    p.symbol, p.side, p.opened_at || now,
    p.entry_price, p.stop_loss, p.take_profit, p.size, now,
  )));

  await mirrorLivePositions(positions, env, now);
  return { saved: positions.length };
}

// Reemplaza el espejo completo: lo que ya no viene de Bybit es que cerro.
async function mirrorLivePositions(positions, env, now) {
  const rows = [env.DB.prepare('DELETE FROM live_positions')];
  const ins  = env.DB.prepare(`
    INSERT INTO live_positions
    (symbol, side, category, size, entry_price, mark_price, unrealized_pnl, roi_pct,
     leverage, position_value, take_profit, stop_loss, liq_price, opened_at, updated_at, settle_coin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const p of positions) {
    rows.push(ins.bind(
      p.symbol, p.side, p.category, p.size, p.entry_price, p.mark_price,
      p.unrealized_pnl, p.roi_pct, p.leverage, p.position_value,
      p.take_profit, p.stop_loss, p.liq_price, p.opened_at, now, p.settle_coin,
    ));
  }
  await env.DB.batch(rows);
}

// Une los snapshots con los trades cerrados que todavia no tienen stop guardado.
async function attachStops(env) {
  const res = await env.DB.prepare(`
    UPDATE trades SET
      stop_source = 'exchange',
      stop_price = (
        SELECT s.stop_price FROM position_snapshots s
        WHERE s.symbol = trades.symbol AND s.side = trades.side
          AND s.stop_price IS NOT NULL
          AND s.seen_at BETWEEN trades.entry_time - 900 AND COALESCE(trades.exit_time, trades.entry_time) + 900
        ORDER BY s.seen_at DESC LIMIT 1
      ),
      risk_usd = (
        SELECT ABS(trades.entry_price - s.stop_price) * trades.size FROM position_snapshots s
        WHERE s.symbol = trades.symbol AND s.side = trades.side
          AND s.stop_price IS NOT NULL
          AND s.seen_at BETWEEN trades.entry_time - 900 AND COALESCE(trades.exit_time, trades.entry_time) + 900
        ORDER BY s.seen_at DESC LIMIT 1
      )
    WHERE status = 'closed' AND stop_price IS NULL AND EXISTS (
      SELECT 1 FROM position_snapshots s
      WHERE s.symbol = trades.symbol AND s.side = trades.side
        AND s.stop_price IS NOT NULL
        AND s.seen_at BETWEEN trades.entry_time - 900 AND COALESCE(trades.exit_time, trades.entry_time) + 900
    )
  `).run();
  return res.meta.changes;
}

// full=true reprocesa todo el historial disponible en vez de solo lo nuevo.
// Sirve para corregir filas viejas: el upsert pisa fees, pnl y precios.
// El backfill historico se pide por tramos (?from=&to= en ms). Cloudflare corta
// a 50 subpeticiones por invocacion y closed-pnl solo acepta ventanas de 7 dias,
// asi que un anio entero no entra en una sola llamada.
async function runSync(env, params) {
  const cfg = await env.DB.prepare('SELECT * FROM sync_configs WHERE id = ? AND enabled = 1').bind('bybit').first();
  if (!cfg) return json({ skipped: true, reason: 'no config or disabled' });

  const from = params?.get('from') ? +params.get('from') : null;
  const to   = params?.get('to')   ? +params.get('to')   : null;
  const backfill = from != null;

  const since = backfill ? from : (cfg.last_sync > 0 ? cfg.last_sync * 1000 : 0);
  const opts  = { since, until: to || Date.now() };
  const [linear, inverse] = await Promise.all([
    fetchBybitFutures(cfg.api_key, cfg.api_secret, { category: 'linear',  ...opts }),
    fetchBybitFutures(cfg.api_key, cfg.api_secret, { category: 'inverse', ...opts }),
  ]);

  const all = [...linear, ...inverse];
  const result   = await upsertTrades(all, env);
  const stopped  = await attachStops(env);
  const planned  = await attachPlans(env);
  // El balance alimenta el drawdown en %; se refresca aca para que un sync
  // manual lo actualice sin esperar al cron
  const balance  = await refreshBalance(env).catch(() => null);
  if (!backfill) {
    await env.DB.prepare('UPDATE sync_configs SET last_sync = ? WHERE id = ?')
      .bind(Math.floor(Date.now() / 1000), 'bybit').run();
  }

  return json({ ok: true, ...result, stops_attached: stopped, plans_applied: planned, backfill, equity: balance?.total_equity ?? null, synced_at: Date.now() });
}
