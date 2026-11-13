// Binance: futuros USDⓈ-M y spot.
// Desde dic-2025 los STOP_MARKET/TAKE_PROFIT_MARKET de futuros van por el
// Algo Service (/fapi/v1/algoOrder); el endpoint normal devuelve -4120.

import { hmacRaw, hex, fmt, num, STABLES, sleep, listOf } from './common.js';
import { floorStep, roundTick } from '../risk.js';

const HOSTS = {
  live: { fapi: 'https://fapi.binance.com',      spot: 'https://api.binance.com' },
  demo: { fapi: 'https://demo-fapi.binance.com', spot: 'https://testnet.binance.vision' },
};

const INFO_TTL = 3600 * 1000;
const infoCache = new Map();   // vive mientras el Durable Object siga en memoria

export function binance({ key, secret, env = 'live' }) {
  const host = HOSTS[env] || HOSTS.live;
  let dual = null;

  async function call(method, base, path, params = {}, signed = true) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if (signed) {
      q.set('recvWindow', '5000');
      q.set('timestamp', String(Date.now()));
      q.set('signature', hex(await hmacRaw(secret, q.toString())));
    }
    const res = await fetch(`${base}${path}?${q}`, { method, headers: signed ? { 'X-MBX-APIKEY': key } : {} });
    const text = await res.text();
    let d; try { d = JSON.parse(text); } catch { d = text; }
    if (!res.ok || (d && typeof d === 'object' && !Array.isArray(d) && d.code < 0)) {
      const err = new Error(`Binance ${d?.code ?? res.status}: ${d?.msg ?? text.slice(0, 200)}`);
      err.code = d?.code; err.status = res.status;
      throw err;
    }
    return d;
  }
  const F = (m, p, q, s) => call(m, host.fapi, p, q, s);
  const S = (m, p, q, s) => call(m, host.spot, p, q, s);

  async function isDual() {
    if (dual == null) dual = !!(await F('GET', '/fapi/v1/positionSide/dual')).dualSidePosition;
    return dual;
  }

  async function exchangeInfo(market) {
    const c = infoCache.get(env + market);
    if (c && Date.now() - c.t < INFO_TTL) return c.data;
    const d = market === 'futures' ? await F('GET', '/fapi/v1/exchangeInfo', {}, false) : null;
    if (d) infoCache.set(env + market, { t: Date.now(), data: d });
    return d;
  }

  function parseFilters(s, fee) {
    const f = Object.fromEntries((s.filters || []).map(x => [x.filterType, x]));
    return {
      symbol: s.symbol,
      tick: num(f.PRICE_FILTER?.tickSize),
      step: num(f.LOT_SIZE?.stepSize),
      min_qty: num(f.LOT_SIZE?.minQty),
      min_notional: num(f.MIN_NOTIONAL?.notional ?? f.MIN_NOTIONAL?.minNotional ?? f.NOTIONAL?.minNotional),
      fee,
      order_types: s.orderTypes || [],
      base: s.baseAsset,
    };
  }

  // ── Lectura ────────────────────────────────────────────────────────────────

  async function equity() {
    const [fut, spot] = await Promise.allSettled([F('GET', '/fapi/v3/account'), spotHoldings(true)]);
    if (fut.status === 'rejected' && spot.status === 'rejected') throw fut.reason;
    const futEq  = fut.status === 'fulfilled' ? num(fut.value.totalMarginBalance) : 0;
    const futAv  = fut.status === 'fulfilled' ? num(fut.value.availableBalance) : 0;
    const spotV  = spot.status === 'fulfilled' ? spot.value.reduce((s, h) => s + h.value, 0) : 0;
    return {
      futures_equity: futEq, futures_available: futAv, spot_value: spotV, total: futEq + spotV,
      errors: [fut, spot].filter(x => x.status === 'rejected').map(x => x.reason.message),
    };
  }

  async function stopsBySymbol() {
    // Algo Service + ordenes viejas que aun vivan en el libro normal
    const [algo, legacy] = await Promise.allSettled([F('GET', '/fapi/v1/openAlgoOrders'), F('GET', '/fapi/v1/openOrders')]);
    const out = [];
    for (const o of algo.status === 'fulfilled' ? listOf(algo.value) : []) {
      out.push({ symbol: o.symbol, kind: o.orderType || o.type, side: o.side, positionSide: o.positionSide,
                 price: num(o.triggerPrice), ref: { algoId: o.algoId } });
    }
    for (const o of legacy.status === 'fulfilled' ? legacy.value : []) {
      if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT'].includes(o.type)) continue;
      out.push({ symbol: o.symbol, kind: o.type, side: o.side, positionSide: o.positionSide,
                 price: num(o.stopPrice), ref: { orderId: o.orderId } });
    }
    return out;
  }

  async function futuresPositions() {
    const [rows, stops] = await Promise.all([F('GET', '/fapi/v3/positionRisk'), stopsBySymbol()]);
    return rows.filter(p => num(p.positionAmt) !== 0).map(p => {
      const amt = num(p.positionAmt);
      const side = p.positionSide === 'LONG' ? 'long' : p.positionSide === 'SHORT' ? 'short' : (amt > 0 ? 'long' : 'short');
      // Un stop cierra la posicion en la direccion contraria
      const closeSide = side === 'long' ? 'SELL' : 'BUY';
      const mine = stops.filter(s => s.symbol === p.symbol && s.side === closeSide &&
        (p.positionSide === 'BOTH' || !s.positionSide || s.positionSide === p.positionSide));
      const sl = mine.filter(s => s.kind?.startsWith('STOP'));
      const tp = mine.filter(s => s.kind?.startsWith('TAKE_PROFIT'));
      // Si hay varios stops, el que protege es el mas cercano al precio
      const best = sl.sort((a, b) => side === 'long' ? b.price - a.price : a.price - b.price)[0];
      const notional = Math.abs(num(p.notional));
      const im = num(p.initialMargin) || num(p.isolatedMargin);
      return {
        exchange: 'binance', market: 'futures', symbol: p.symbol, side,
        position_side: p.positionSide,
        size: Math.abs(amt), entry: num(p.entryPrice), mark: num(p.markPrice),
        upnl: num(p.unRealizedProfit), liq: num(p.liquidationPrice) || null,
        leverage: im > 0 ? Math.round(notional / im) : null, notional,
        stop: best?.price || null, stop_refs: sl.map(s => s.ref),
        tp: tp[0]?.price || null, opened_at: p.updateTime ? Math.floor(p.updateTime / 1000) : null,
      };
    });
  }

  async function spotHoldings(quiet = false) {
    const [acct, prices] = await Promise.all([
      S('GET', '/api/v3/account', { omitZeroBalances: 'true' }),
      S('GET', '/api/v3/ticker/price', {}, false),
    ]);
    const px = new Map(prices.map(p => [p.symbol, num(p.price)]));
    return acct.balances.map(b => {
      const qty = num(b.free) + num(b.locked);
      const price = STABLES.has(b.asset) ? 1 : (px.get(b.asset + 'USDT') || px.get(b.asset + 'USDC') || 0);
      return { exchange: 'binance', market: 'spot', asset: b.asset, symbol: b.asset + 'USDT',
               qty, free: num(b.free), price, value: qty * price, stable: STABLES.has(b.asset) };
    }).filter(h => h.value >= 1 || (!quiet && h.qty > 0 && !h.price));
  }

  async function instrument(market, symbol) {
    if (market === 'futures') {
      const info = await exchangeInfo('futures');
      const s = info.symbols.find(x => x.symbol === symbol);
      if (!s) throw new Error(`${symbol} no existe en Binance Futures`);
      if (s.status !== 'TRADING') throw new Error(`${symbol} no esta operable en Binance Futures (${s.status})`);
      return parseFilters(s, 0.0005);
    }
    const info = await S('GET', '/api/v3/exchangeInfo', { symbol }, false);
    const s = info.symbols?.[0];
    if (!s) throw new Error(`${symbol} no existe en Binance Spot`);
    return parseFilters(s, 0.001);
  }

  async function price(market, symbol) {
    if (market === 'futures') return num((await F('GET', '/fapi/v1/premiumIndex', { symbol }, false)).markPrice);
    return num((await S('GET', '/api/v3/ticker/price', { symbol }, false)).price);
  }

  async function klines(market, symbol, interval = '5m', limit = 500) {
    const rows = market === 'futures'
      ? await F('GET', '/fapi/v1/klines', { symbol, interval, limit }, false)
      : await S('GET', '/api/v3/klines', { symbol, interval, limit }, false);
    return rows.map(r => ({ t: r[0], o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }));
  }

  // ── Futuros: ejecucion ─────────────────────────────────────────────────────

  async function placeStopAlgo(symbol, side, positionSide, kind, trigger, tick) {
    return F('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol,
      side: side === 'long' ? 'SELL' : 'BUY',
      positionSide: positionSide && positionSide !== 'BOTH' ? positionSide : undefined,
      type: kind, triggerPrice: fmt(roundTick(trigger, tick), tick),
      closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true',
    });
  }

  async function openFutures({ symbol, side, qty, type, price: limitPrice, stop, tp, leverage, cid, inst }) {
    const hedge = await isDual();
    const positionSide = hedge ? (side === 'long' ? 'LONG' : 'SHORT') : undefined;
    try { await F('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
    catch (e) { if (e.code !== -4046) throw e; }   // -4046: ya estaba en aislado
    await F('POST', '/fapi/v1/leverage', { symbol, leverage });

    const order = await F('POST', '/fapi/v1/order', {
      symbol, side: side === 'long' ? 'BUY' : 'SELL', positionSide,
      type: type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: fmt(qty, inst.step),
      price: type === 'limit' ? fmt(roundTick(limitPrice, inst.tick), inst.tick) : undefined,
      timeInForce: type === 'limit' ? 'GTC' : undefined,
      newClientOrderId: cid, newOrderRespType: 'RESULT',
    });

    // closePosition se puede dejar puesto antes de que entre la limite
    let stopErr = null, tpErr = null;
    try { await placeStopAlgo(symbol, side, positionSide, 'STOP_MARKET', stop, inst.tick); }
    catch (e) { stopErr = e.message; }
    if (tp) {
      try { await placeStopAlgo(symbol, side, positionSide, 'TAKE_PROFIT_MARKET', tp, inst.tick); }
      catch (e) { tpErr = e.message; }
    }
    return {
      order_id: String(order.orderId),
      filled: order.status === 'FILLED',
      avg_price: num(order.avgPrice) || null,
      filled_qty: num(order.executedQty),
      stop_error: stopErr, tp_error: tpErr,
    };
  }

  // Primero se pone el nuevo y despues se quita el viejo: nunca queda sin stop
  async function setStop(pos, stop) {
    const inst = await instrument('futures', pos.symbol);
    await placeStopAlgo(pos.symbol, pos.side, pos.position_side, 'STOP_MARKET', stop, inst.tick);
    for (const ref of pos.stop_refs || []) {
      try {
        if (ref.algoId) await F('DELETE', '/fapi/v1/algoOrder', { algoId: ref.algoId });
        else await F('DELETE', '/fapi/v1/order', { symbol: pos.symbol, orderId: ref.orderId });
      } catch (e) { console.error('cancel old stop', e.message); }
    }
  }

  async function reduce(pos, qty) {
    const inst = await instrument('futures', pos.symbol);
    const hedge = pos.position_side && pos.position_side !== 'BOTH';
    const q = floorStep(Math.min(qty, pos.size), inst.step);
    if (!(q > 0)) return null;
    return F('POST', '/fapi/v1/order', {
      symbol: pos.symbol, side: pos.side === 'long' ? 'SELL' : 'BUY',
      positionSide: hedge ? pos.position_side : undefined,
      reduceOnly: hedge ? undefined : 'true',
      type: 'MARKET', quantity: fmt(q, inst.step),
    });
  }

  const closePosition = pos => reduce(pos, pos.size);

  async function orderState(market, symbol, cid) {
    const o = market === 'futures'
      ? await F('GET', '/fapi/v1/order', { symbol, origClientOrderId: cid })
      : await S('GET', '/api/v3/order', { symbol, origClientOrderId: cid });
    const map = { NEW: 'open', PARTIALLY_FILLED: 'partial', FILLED: 'filled' };
    return { state: map[o.status] || 'cancelled', filled_qty: num(o.executedQty), avg_price: num(o.avgPrice) || null };
  }

  async function cancelOrder(market, symbol, cid) {
    if (market === 'futures') return F('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: cid });
    return S('DELETE', '/api/v3/order', { symbol, origClientOrderId: cid });
  }

  // Los stops con closePosition pueden quedar vivos tras cerrar: se limpian
  async function cleanup(symbol) {
    try { await F('DELETE', '/fapi/v1/algoOpenOrders', { symbol }); } catch (e) { console.error('cleanup algo', e.message); }
  }

  async function closedPnl(symbol, side, sinceMs) {
    const fills = await F('GET', '/fapi/v1/userTrades', { symbol, startTime: sinceMs - 60000, limit: 1000 });
    const closing = side === 'long' ? 'SELL' : 'BUY';
    let pnl = 0, fees = 0, q = 0, notional = 0, last = 0;
    for (const f of fills) {
      pnl += num(f.realizedPnl);
      if (f.commissionAsset === 'USDT' || f.commissionAsset === 'USDC') fees += num(f.commission);
      if (f.side === closing) { q += num(f.qty); notional += num(f.qty) * num(f.price); last = Math.max(last, f.time); }
    }
    return { pnl: pnl - fees, fees, exit_price: q ? notional / q : null, closed_at: last ? Math.floor(last / 1000) : null };
  }

  // ── Spot ───────────────────────────────────────────────────────────────────

  async function spotStopOrders(symbol) {
    const orders = await S('GET', '/api/v3/openOrders', { symbol });
    return orders.filter(o => o.side === 'SELL' && (o.type === 'STOP_LOSS' || o.type === 'STOP_LOSS_LIMIT'));
  }

  async function spotPlaceStop(symbol, qty, stop, tp, inst) {
    inst ||= await instrument('spot', symbol);
    const q = fmt(floorStep(qty, inst.step), inst.step);
    const market = inst.order_types.includes('STOP_LOSS');
    const below = market
      ? { belowType: 'STOP_LOSS', belowStopPrice: fmt(roundTick(stop, inst.tick), inst.tick) }
      : { belowType: 'STOP_LOSS_LIMIT', belowStopPrice: fmt(roundTick(stop, inst.tick), inst.tick),
          belowPrice: fmt(roundTick(stop * 0.995, inst.tick), inst.tick), belowTimeInForce: 'GTC' };
    if (tp) {
      // OCO: el saldo solo se puede comprometer una vez, stop y objetivo van juntos
      return S('POST', '/api/v3/orderList/oco', {
        symbol, side: 'SELL', quantity: q,
        aboveType: 'LIMIT_MAKER', abovePrice: fmt(roundTick(tp, inst.tick), inst.tick), ...below,
      });
    }
    return S('POST', '/api/v3/order', market
      ? { symbol, side: 'SELL', type: 'STOP_LOSS', quantity: q, stopPrice: below.belowStopPrice }
      : { symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT', quantity: q, stopPrice: below.belowStopPrice,
          price: below.belowPrice, timeInForce: 'GTC' });
  }

  async function openSpot({ symbol, qty, stop, tp, cid, inst }) {
    const o = await S('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'MARKET', quantity: fmt(qty, inst.step),
      newClientOrderId: cid, newOrderRespType: 'FULL',
    });
    // Si la comision se cobra en el activo comprado, el saldo es menor que lo ejecutado
    let filled = num(o.executedQty);
    for (const f of o.fills || []) if (f.commissionAsset === inst.base) filled -= num(f.commission);
    const avg = num(o.executedQty) ? num(o.cummulativeQuoteQty) / num(o.executedQty) : null;
    let stopErr = null;
    try { await spotPlaceStop(symbol, filled, stop, tp, inst); }
    catch (e) { stopErr = e.message; }
    return { order_id: String(o.orderId), filled: true, filled_qty: floorStep(filled, inst.step), avg_price: avg, stop_error: stopErr };
  }

  async function spotClose(symbol) {
    try { await S('DELETE', '/api/v3/openOrders', { symbol }); } catch (e) { if (e.code !== -2011) throw e; }
    await sleep(300);
    const inst = await instrument('spot', symbol);
    const acct = await S('GET', '/api/v3/account', { omitZeroBalances: 'true' });
    const free = num(acct.balances.find(b => b.asset === inst.base)?.free);
    const q = floorStep(free, inst.step);
    if (!(q > 0)) return null;
    return S('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity: fmt(q, inst.step) });
  }

  async function spotPnl(symbol, sinceMs, entryCost) {
    const fills = await S('GET', '/api/v3/myTrades', { symbol, startTime: sinceMs - 60000, limit: 1000 });
    let sold = 0, proceeds = 0, fees = 0, last = 0;
    for (const f of fills) {
      if (f.commissionAsset === 'USDT') fees += num(f.commission);
      if (!f.isBuyer) { sold += num(f.qty); proceeds += num(f.quoteQty); last = Math.max(last, f.time); }
    }
    if (!sold) return null;
    return { pnl: proceeds - entryCost - fees, exit_price: proceeds / sold, closed_at: last ? Math.floor(last / 1000) : null };
  }

  return {
    name: 'binance', equity, futuresPositions, spotHoldings, instrument, price, klines,
    openFutures, setStop, reduce, closePosition, orderState, cancelOrder, cleanup, closedPnl,
    spotStopOrders, spotPlaceStop, openSpot, spotClose, spotPnl,
    diag: async () => ({ futures: !!(await F('GET', '/fapi/v1/time', {}, false)).serverTime, hedge: await isDual() }),
  };
}
