// ingestion.js — Bybit + Binance API wrappers

async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function session(unixSec) {
  const h = new Date(unixSec * 1000).getUTCHours();
  if (h < 8)  return 'asia';
  if (h < 12) return 'london';
  if (h < 21) return 'ny';
  return 'other';
}

// ── Bybit V5 ──────────────────────────────────────────────────────────────────

async function bybitHeaders(apiKey, apiSecret, queryString) {
  const ts   = Date.now();
  const recv = '5000';
  const sig  = await hmac(apiSecret, `${ts}${apiKey}${recv}${queryString}`);
  return {
    'X-BAPI-API-KEY':      apiKey,
    'X-BAPI-TIMESTAMP':    String(ts),
    'X-BAPI-SIGN':         sig,
    'X-BAPI-RECV-WINDOW':  recv,
  };
}

// Linear/Inverse futures — uses /v5/position/closed-pnl
export async function fetchBybitFutures(apiKey, apiSecret, opts = {}) {
  const { category = 'linear', symbol, limit = 200 } = opts;
  const trades = [];
  let cursor = '';

  do {
    let qs = `category=${category}&limit=${limit}`;
    if (symbol) qs += `&symbol=${symbol}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;

    const headers = await bybitHeaders(apiKey, apiSecret, qs);
    const res     = await fetch(`https://api.bybit.com/v5/position/closed-pnl?${qs}`, { headers });
    if (!res.ok) throw new Error(`Bybit ${res.status}: ${await res.text()}`);
    const d = await res.json();
    if (d.retCode !== 0) throw new Error(`Bybit: ${d.retMsg}`);

    for (const t of d.result?.list || []) {
      const entryTs = Math.floor(parseInt(t.createdTime || t.updatedTime || Date.now()) / 1000);
      const exitTs  = t.updatedTime ? Math.floor(parseInt(t.updatedTime) / 1000) : null;
      trades.push({
        symbol:      t.symbol,
        category,
        side:        t.side?.toLowerCase() === 'buy' ? 'long' : 'short',
        entry_price: parseFloat(t.avgEntryPrice || 0),
        exit_price:  parseFloat(t.avgExitPrice  || 0) || null,
        size:        parseFloat(t.qty || t.size || 0),
        pnl:         parseFloat(t.closedPnl || 0),
        fees:        Math.abs(parseFloat(t.cumEntryValue || 0)) * 0.00055,
        entry_time:  entryTs,
        exit_time:   exitTs,
        session:     session(entryTs),
        exec_type:   'bot',
        status:      'closed',
        exchange:    'bybit',
        exchange_id: t.orderId || null,
      });
    }

    cursor = d.result?.nextPageCursor || '';
  } while (cursor && trades.length < 2000);

  return trades;
}

// Spot — uses /v5/order/history
export async function fetchBybitSpot(apiKey, apiSecret, symbol) {
  const qs      = `category=spot${symbol ? '&symbol=' + symbol : ''}&limit=50&orderStatus=Filled`;
  const headers = await bybitHeaders(apiKey, apiSecret, qs);
  const res     = await fetch(`https://api.bybit.com/v5/order/history?${qs}`, { headers });
  if (!res.ok) throw new Error(`Bybit Spot ${res.status}: ${await res.text()}`);
  const d = await res.json();
  if (d.retCode !== 0) throw new Error(`Bybit Spot: ${d.retMsg}`);

  return (d.result?.list || []).map(o => {
    const ts    = Math.floor(parseInt(o.createdTime) / 1000);
    const side  = o.side?.toLowerCase() === 'buy' ? 'buy' : 'sell';
    const price = parseFloat(o.avgPrice || o.price || 0);
    const qty   = parseFloat(o.cumExecQty || 0);
    const fee   = parseFloat(o.cumExecFee || 0);
    return {
      symbol:      o.symbol,
      category:    'spot',
      side,
      entry_price: price,
      exit_price:  null,
      size:        qty,
      pnl:         side === 'sell' ? price * qty - fee : null,
      fees:        fee,
      entry_time:  ts,
      exit_time:   null,
      session:     session(ts),
      exec_type:   'bot',
      status:      side === 'sell' ? 'closed' : 'open',
      exchange:    'bybit',
      exchange_id: o.orderId,
    };
  });
}

// ── Binance ───────────────────────────────────────────────────────────────────

// Futures (fapi) — userTrades endpoint (fill-level, grouped by orderId)
export async function fetchBinanceFutures(apiKey, apiSecret, symbol, limit = 1000) {
  const ts  = Date.now();
  const qs  = `symbol=${symbol}&limit=${limit}&timestamp=${ts}`;
  const sig = await hmac(apiSecret, qs);
  const res = await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!res.ok) throw new Error(`Binance Futures ${res.status}: ${await res.text()}`);
  const fills = await res.json();

  // Group fills → positions
  const orders = new Map();
  for (const f of fills) {
    const id = String(f.orderId);
    if (!orders.has(id)) orders.set(id, []);
    orders.get(id).push(f);
  }

  return [...orders.values()].map(fls => {
    const first = fls[0];
    const qty   = fls.reduce((s, f) => s + parseFloat(f.qty), 0);
    const avg   = fls.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / qty;
    const pnl   = fls.reduce((s, f) => s + parseFloat(f.realizedPnl || 0), 0);
    const fees  = fls.reduce((s, f) => s + parseFloat(f.commission  || 0), 0);
    const ts2   = Math.floor(first.time / 1000);
    return {
      symbol:      first.symbol,
      category:    'linear',
      side:        first.side === 'BUY' ? 'long' : 'short',
      entry_price: avg,
      exit_price:  null,
      size:        qty,
      pnl,
      fees,
      entry_time:  ts2,
      exit_time:   null,
      session:     session(ts2),
      exec_type:   'bot',
      status:      'closed',
      exchange:    'binance',
      exchange_id: String(first.orderId),
    };
  });
}

// Spot
export async function fetchBinanceSpot(apiKey, apiSecret, symbol, limit = 1000) {
  const ts  = Date.now();
  const qs  = `symbol=${symbol}&limit=${limit}&timestamp=${ts}`;
  const sig = await hmac(apiSecret, qs);
  const res = await fetch(`https://api.binance.com/api/v3/myTrades?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!res.ok) throw new Error(`Binance Spot ${res.status}: ${await res.text()}`);
  const trades = await res.json();

  return trades.map(t => {
    const ts2 = Math.floor(t.time / 1000);
    return {
      symbol:      t.symbol,
      category:    'spot',
      side:        t.isBuyer ? 'buy' : 'sell',
      entry_price: parseFloat(t.price),
      exit_price:  null,
      size:        parseFloat(t.qty),
      pnl:         t.isBuyer ? null : parseFloat(t.qty) * parseFloat(t.price),
      fees:        parseFloat(t.commission || 0),
      entry_time:  ts2,
      exit_time:   null,
      session:     session(ts2),
      exec_type:   'bot',
      status:      t.isBuyer ? 'open' : 'closed',
      exchange:    'binance',
      exchange_id: String(t.id),
    };
  });
}
