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
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function fetchBybitFutures(apiKey, apiSecret, opts = {}) {
  const { category = 'linear', symbol, limit = 200, since = 0, until = 0, maxTrades = 2000 } = opts;
  // closed-pnl solo acepta ventanas de 7 dias: pedir un rango mayor devuelve
  // vacio en silencio. Se recorre semana por semana hacia atras.
  const now   = until > 0 ? until : Date.now();
  const start = since > 0 ? since : now - 365 * 24 * 60 * 60 * 1000;

  const trades = [];
  for (let to = now; to > start && trades.length < maxTrades; to -= WEEK_MS) {
    const from = Math.max(start, to - WEEK_MS);
    await fetchClosedPnlWindow(apiKey, apiSecret, { category, symbol, limit, from, to, trades });
  }
  return trades;
}

async function fetchClosedPnlWindow(apiKey, apiSecret, { category, symbol, limit, from, to, trades }) {
  let cursor = '';
  do {
    let qs = `category=${category}&limit=${limit}&startTime=${Math.floor(from)}&endTime=${Math.floor(to)}`;
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
        // closed-pnl side = closing side: Sell=closed a Long, Buy=closed a Short
        side:        t.side?.toLowerCase() === 'sell' ? 'long' : 'short',
        entry_price: parseFloat(t.avgEntryPrice || 0),
        exit_price:  parseFloat(t.avgExitPrice  || 0) || null,
        size:        parseFloat(t.qty || t.size || 0),
        pnl:         parseFloat(t.closedPnl || 0),
        // openFee/closeFee son los fees reales del endpoint; el estimado solo es fallback
        fees:        (t.openFee != null || t.closeFee != null)
                       ? Math.abs(parseFloat(t.openFee || 0)) + Math.abs(parseFloat(t.closeFee || 0))
                       : Math.abs(parseFloat(t.cumEntryValue || 0)) * 0.00055,
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
  } while (cursor);
}

// Live open positions — /v5/position/list. Solo lectura, no toca la DB.
export async function fetchBybitPositions(apiKey, apiSecret, opts = {}) {
  // En inverse no se filtra por settleCoin: cada par liquida en su propia
  // moneda (ETHUSD en ETH, BTCUSD en BTC), asi que filtrar se come posiciones.
  const groups = opts.groups || [
    { category: 'linear',  settleCoin: 'USDT' },
    { category: 'linear',  settleCoin: 'USDC' },
    { category: 'inverse' },
  ];

  const settled = await Promise.allSettled(groups.map(async ({ category, settleCoin }) => {
    const qs      = `category=${category}${settleCoin ? `&settleCoin=${settleCoin}` : ''}&limit=200`;
    const headers = await bybitHeaders(apiKey, apiSecret, qs);
    const res     = await fetch(`https://api.bybit.com/v5/position/list?${qs}`, { headers });
    if (!res.ok) throw new Error(`Bybit ${res.status}: ${await res.text()}`);
    const d = await res.json();
    if (d.retCode !== 0) throw new Error(`Bybit ${category}${settleCoin ? '/' + settleCoin : ''}: ${d.retMsg}`);
    return (d.result?.list || []).map(p => ({ ...p, _category: category }));
  }));

  const errors = settled.filter(s => s.status === 'rejected').map(s => s.reason?.message || String(s.reason));
  if (errors.length === settled.length) throw new Error(errors[0]);

  const positions = settled
    .filter(s => s.status === 'fulfilled')
    .flatMap(s => s.value)
    .filter(p => parseFloat(p.size || 0) > 0)
    .map(p => {
      const size   = parseFloat(p.size);
      const entry  = parseFloat(p.avgPrice || 0);
      const upnl   = parseFloat(p.unrealisedPnl || 0);
      const value  = parseFloat(p.positionValue || 0) || entry * size;
      const lev    = parseFloat(p.leverage || 0) || null;
      const margin = lev ? value / lev : null;
      return {
        symbol:         p.symbol,
        category:       p._category,
        side:           p.side === 'Buy' ? 'long' : 'short',
        size,
        entry_price:    entry,
        mark_price:     parseFloat(p.markPrice || 0) || null,
        unrealized_pnl: upnl,
        roi_pct:        margin ? (upnl / margin) * 100 : (value ? (upnl / value) * 100 : null),
        leverage:       lev,
        position_value: value,
        take_profit:    parseFloat(p.takeProfit || 0) || null,
        stop_loss:      parseFloat(p.stopLoss   || 0) || null,
        liq_price:      parseFloat(p.liqPrice   || 0) || null,
        opened_at:      p.createdTime ? Math.floor(parseInt(p.createdTime) / 1000) : null,
        // inverse liquida en la moneda base: ETHUSD paga en ETH, no en USDT
        settle_coin:    p._category === 'inverse'
                          ? p.symbol.replace(/USD.*$/, '')
                          : (p.symbol.endsWith('USDC') ? 'USDC' : 'USDT'),
        exchange:       'bybit',
      };
    })
    .sort((a, b) => b.position_value - a.position_value);

  return { positions, errors };
}

// Spot — /v5/order/history, paginado con cursor.
// Sin paginar solo llegaban 50 ordenes, lo que dejaba el historial incompleto
// y hacia imposible calcular el costo base de una venta.
export async function fetchBybitSpot(apiKey, apiSecret, symbol, maxOrders = 1000) {
  const orders = [];
  let cursor = '';

  do {
    let qs = `category=spot${symbol ? '&symbol=' + symbol : ''}&limit=50&orderStatus=Filled`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;

    const headers = await bybitHeaders(apiKey, apiSecret, qs);
    const res     = await fetch(`https://api.bybit.com/v5/order/history?${qs}`, { headers });
    if (!res.ok) throw new Error(`Bybit Spot ${res.status}: ${await res.text()}`);
    const d = await res.json();
    if (d.retCode !== 0) throw new Error(`Bybit Spot: ${d.retMsg}`);

    orders.push(...(d.result?.list || []));
    cursor = d.result?.nextPageCursor || '';
  } while (cursor && orders.length < maxOrders);

  return buildSpotTrades(orders);
}

// Casa ventas contra compras por costo promedio. Una venta solo lleva PnL si
// hay compras previas que la respalden; si el historial no alcanza, queda null
// en vez de un numero inventado.
export function buildSpotTrades(orders) {
  const bySymbol = new Map();
  for (const o of orders) {
    if (!bySymbol.has(o.symbol)) bySymbol.set(o.symbol, []);
    bySymbol.get(o.symbol).push(o);
  }

  const out = [];
  for (const [, list] of bySymbol) {
    list.sort((a, b) => parseInt(a.createdTime) - parseInt(b.createdTime));

    let heldQty = 0, heldCost = 0;   // inventario y su costo acumulado
    for (const o of list) {
      const ts    = Math.floor(parseInt(o.createdTime) / 1000);
      const isBuy = o.side?.toLowerCase() === 'buy';
      const price = parseFloat(o.avgPrice || o.price || 0);
      const qty   = parseFloat(o.cumExecQty || 0);
      const fee   = parseFloat(o.cumExecFee || 0);
      if (!(qty > 0)) continue;

      let pnl = null;
      if (isBuy) {
        heldQty  += qty;
        heldCost += qty * price;
      } else if (heldQty > 0) {
        // Solo se puede casar contra lo que tenemos registrado
        const matched  = Math.min(qty, heldQty);
        const avgCost  = heldCost / heldQty;
        pnl      = (price - avgCost) * matched - fee;
        heldCost -= avgCost * matched;
        heldQty  -= matched;
      }

      out.push({
        symbol:      o.symbol,
        category:    'spot',
        side:        isBuy ? 'buy' : 'sell',
        entry_price: price,
        exit_price:  null,
        size:        qty,
        pnl,
        fees:        fee,
        entry_time:  ts,
        exit_time:   null,
        session:     session(ts),
        exec_type:   'bot',
        status:      isBuy ? 'open' : 'closed',
        exchange:    'bybit',
        exchange_id: o.orderId,
      });
    }
  }
  return out;
}

// ── Binance ───────────────────────────────────────────────────────────────────

// Futures (fapi) — userTrades da fills sueltos, no posiciones. Hay que
// reconstruir cada posicion recorriendo los fills en orden y acumulando la
// cantidad neta: la posicion abre cuando el neto sale de 0 y cierra al volver a 0.
export function buildBinancePositions(fills) {
  const groups = new Map();
  for (const f of fills) {
    const key = `${f.symbol}|${f.positionSide || 'BOTH'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const out = [];
  for (const [, list] of groups) {
    list.sort((a, b) => a.time - b.time || a.id - b.id);

    let pos = null;
    const openPos = (dir, firstFill) => ({
      dir,
      net: 0,
      entryQty: 0, entryNotional: 0,
      exitQty: 0,  exitNotional: 0,
      pnl: 0, fees: 0,
      openTime: Math.floor(firstFill.time / 1000),
      closeTime: null,
      firstId: String(firstFill.id),
      symbol: firstFill.symbol,
    });
    const emit = (p) => {
      if (!p.entryQty) return;
      out.push({
        symbol:      p.symbol,
        category:    'linear',
        side:        p.dir > 0 ? 'long' : 'short',
        entry_price: p.entryNotional / p.entryQty,
        exit_price:  p.exitQty ? p.exitNotional / p.exitQty : null,
        size:        p.entryQty,
        pnl:         p.pnl,
        fees:        p.fees,
        entry_time:  p.openTime,
        exit_time:   p.closeTime,
        session:     session(p.openTime),
        exec_type:   'bot',
        status:      'closed',
        exchange:    'binance',
        exchange_id: `${p.symbol}:${p.firstId}`,
      });
    };

    for (const f of list) {
      const qty    = parseFloat(f.qty);
      const price  = parseFloat(f.price);
      const signed = f.side === 'BUY' ? qty : -qty;
      const fee    = parseFloat(f.commission  || 0);
      const rpnl   = parseFloat(f.realizedPnl || 0);

      if (!pos) pos = openPos(Math.sign(signed), f);

      // Parte del fill que reduce la posicion actual y parte que la invierte
      const reducing = Math.sign(signed) !== pos.dir && pos.net !== 0
        ? Math.min(qty, Math.abs(pos.net))
        : 0;
      const adding = qty - reducing;

      pos.fees += fee;

      if (reducing > 0) {
        pos.exitQty      += reducing;
        pos.exitNotional += reducing * price;
        pos.pnl          += rpnl;
        pos.net          += pos.dir > 0 ? -reducing : reducing;
      }

      if (reducing > 0 && pos.net === 0) {
        pos.closeTime = Math.floor(f.time / 1000);
        emit(pos);
        pos = adding > 0 ? openPos(Math.sign(signed), f) : null;
      }

      if (adding > 0) {
        if (!pos) pos = openPos(Math.sign(signed), f);
        pos.entryQty      += adding;
        pos.entryNotional += adding * price;
        pos.net           += pos.dir > 0 ? adding : -adding;
      }
    }
    // La posicion que quedo abierta no se emite: solo guardamos trades cerrados.
  }
  return out;
}

export async function fetchBinanceFutures(apiKey, apiSecret, symbol, limit = 1000) {
  const ts  = Date.now();
  const qs  = `symbol=${symbol}&limit=${limit}&timestamp=${ts}`;
  const sig = await hmac(apiSecret, qs);
  const res = await fetch(`https://fapi.binance.com/fapi/v1/userTrades?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!res.ok) throw new Error(`Binance Futures ${res.status}: ${await res.text()}`);
  return buildBinancePositions(await res.json());
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
      pnl:         null,  // idem Bybit spot: el importe de venta no es ganancia
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

// ── Bybit Transaction Log CSV parser ─────────────────────────────────────────
// Parses CSV exported from Bybit UI → Account → Transaction Log → Export
// Real column format: Currency,Contract,Type,Direction,Quantity,Position,
//   Filled Price,Funding,Fee Paid,Cash Flow,Change,Wallet Balance,Action,OrderId,TradeId,Time
export function parseBybitCSV(csvText) {
  const lines = csvText.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());

  const idx = name => header.findIndex(h => h === name.toLowerCase());

  const iContract   = idx('contract');
  const iType       = idx('type');
  const iDirection  = idx('direction');
  const iQty        = idx('quantity');
  const iPrice      = idx('filled price');
  const iFeePaid    = idx('fee paid');
  const iCashFlow   = idx('cash flow');
  const iAction     = idx('action');
  const iOrderId    = idx('orderid');
  const iTradeId    = idx('tradeid');
  const iTime       = idx('time');

  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',').map(v => v.replace(/"/g, '').trim());
    const type   = (c[iType]   || '').toUpperCase();
    const action = (c[iAction] || '').toUpperCase();

    // Only import closed trade fills
    if (type !== 'TRADE' || action !== 'CLOSE') continue;

    const symbol = (c[iContract] || '').toUpperCase().replace('/', '');
    if (!symbol) continue;

    const rawTime = c[iTime] || '';
    const ts = rawTime
      ? Math.floor(new Date(rawTime.replace(' ', 'T') + (rawTime.includes('Z') ? '' : 'Z')).getTime() / 1000)
      : 0;
    if (!ts || ts <= 0) continue;

    const direction = (c[iDirection] || '').toUpperCase(); // SELL = closed long, BUY = closed short
    const price     = parseFloat(c[iPrice])    || 0;
    const qty       = Math.abs(parseFloat(c[iQty])   || 0);
    const pnl       = parseFloat(c[iCashFlow]) || 0;  // realized PnL for this fill
    const fee       = Math.abs(parseFloat(c[iFeePaid]) || 0);
    const dir       = direction === 'SELL' ? 'long' : 'short';
    const category  = symbol.endsWith('USDT') || symbol.endsWith('USDC') ? 'linear' : 'inverse';
    const tradeId   = c[iTradeId] || `csv_${i}`;
    const orderId   = c[iOrderId] || '';

    trades.push({
      symbol,
      category,
      side:        dir,
      entry_price: price,
      exit_price:  price,
      size:        qty,
      pnl,
      fees:        fee,
      entry_time:  ts,
      exit_time:   ts,
      session:     session(ts),
      exec_type:   'bot',
      status:      'closed',
      exchange:    'bybit',
      exchange_id: `${orderId}_${tradeId}`,
    });
  }
  return trades;
}
