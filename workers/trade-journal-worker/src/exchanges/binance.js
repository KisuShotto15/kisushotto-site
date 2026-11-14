// Binance: futuros USDⓈ-M y spot.
// Desde dic-2025 los STOP_MARKET/TAKE_PROFIT_MARKET de futuros van por el
// Algo Service (/fapi/v1/algoOrder); el endpoint normal devuelve -4120.

import { hmacRaw, hex, fmt, num, STABLES, sleep, listOf, xfetch, cachedPrices } from './common.js';
import { floorStep, roundTick } from '../risk.js';
import { buildBinancePositions } from '../ingestion.js';

const HOSTS = {
  live: { fapi: 'https://fapi.binance.com',      spot: 'https://api.binance.com',      dapi: 'https://dapi.binance.com' },
  demo: { fapi: 'https://demo-fapi.binance.com', spot: 'https://testnet.binance.vision', dapi: 'https://dapi.binance.com' },
};

const INFO_TTL = 3600 * 1000;
const infoCache = new Map();   // vive mientras el Durable Object siga en memoria

export function binance({ key, secret, env = 'live' }) {
  const host = HOSTS[env] || HOSTS.live;
  const dual = {};
  // USDT-M (fapi) y COIN-M (dapi) comparten casi todos los endpoints de ejecucion
  const fx = market => market === 'coinm' ? { X: D, v: '/dapi/v1' } : { X: F, v: '/fapi/v1' };

  async function call(method, base, path, params = {}, signed = true) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if (signed) {
      q.set('recvWindow', '5000');
      q.set('timestamp', String(Date.now()));
      q.set('signature', hex(await hmacRaw(secret, q.toString())));
    }
    const res = await xfetch(`${base}${path}?${q}`, { method, headers: signed ? { 'X-MBX-APIKEY': key } : {} });
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
  const D = (m, p, q, s) => call(m, host.dapi, p, q, s);   // futuros COIN-M

  async function isDual(market = 'futures') {
    const { X, v } = fx(market);
    if (dual[market] == null) dual[market] = !!(await X('GET', `${v}/positionSide/dual`)).dualSidePosition;
    return dual[market];
  }

  async function exchangeInfo(market) {
    const c = infoCache.get(env + market);
    if (c && Date.now() - c.t < INFO_TTL) return c.data;
    const d = market === 'futures' ? await F('GET', '/fapi/v1/exchangeInfo', {}, false)
            : market === 'coinm' ? await D('GET', '/dapi/v1/exchangeInfo', {}, false) : null;
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

  // Precio en USDT de varias monedas (cache de 5 min compartido con spot)
  function spotPx(symbols) {
    if (!symbols.length) return Promise.resolve(new Map());
    return cachedPrices('binance', symbols, async miss => {
      const list = await S('GET', '/api/v3/ticker/price', { symbols: JSON.stringify(miss) }, false).catch(async () => {
        // un simbolo inexistente hace fallar todo el lote: se piden de a uno
        const one = await Promise.all(miss.map(sym => S('GET', '/api/v3/ticker/price', { symbol: sym }, false).catch(() => null)));
        return one.filter(Boolean);
      });
      return list.map(p => [p.symbol, num(p.price)]);
    });
  }

  // ── Futuros COIN-M (solo lectura) ──────────────────────────────────────────
  // Contratos en USD (100 por contrato en BTC, 10 en el resto); el PnL y el
  // margen se liquidan en la moneda base.
  async function coinm() {
    const [acct, rows, legacy, algo] = await Promise.all([
      D('GET', '/dapi/v1/account'), D('GET', '/dapi/v1/positionRisk'),
      D('GET', '/dapi/v1/openOrders').catch(() => []), D('GET', '/dapi/v1/openAlgoOrders').catch(() => []),
    ]);
    const orders = [
      ...listOf(algo).map(o => ({ symbol: o.symbol, side: o.side, type: o.orderType || o.type, stopPrice: o.triggerPrice, ref: { algoId: o.algoId } })),
      ...(Array.isArray(legacy) ? legacy : []).map(o => ({ ...o, ref: { orderId: o.orderId } })),
    ];
    const assets = (acct.assets || []).filter(a => num(a.marginBalance) > 0);
    const px = await spotPx(assets.map(a => a.asset + 'USDT'));
    const value = assets.reduce((s, a) => s + num(a.marginBalance) * (px.get(a.asset + 'USDT') || 0), 0);
    const positions = rows.filter(p => num(p.positionAmt) !== 0).map(p => {
      const amt = num(p.positionAmt);
      const side = p.positionSide === 'LONG' ? 'long' : p.positionSide === 'SHORT' ? 'short' : (amt > 0 ? 'long' : 'short');
      const coin = p.symbol.replace(/USD(_.*)?$/, '');
      const mark = num(p.markPrice);
      const closeSide = side === 'long' ? 'SELL' : 'BUY';
      const mine = (Array.isArray(orders) ? orders : []).filter(o => o.symbol === p.symbol && o.side === closeSide);
      const slOrders = mine.filter(o => /STOP/.test(o.type));
      const sl = slOrders.map(o => num(o.stopPrice)).sort((a, b) => side === 'long' ? b - a : a - b)[0];
      const tp = mine.find(o => /TAKE_PROFIT/.test(o.type));
      const upnlCoin = num(p.unRealizedProfit);
      return {
        exchange: 'binance', market: 'coinm', symbol: p.symbol, side, size: Math.abs(amt), contracts: Math.abs(amt),
        entry: num(p.entryPrice), mark, upnl: upnlCoin * mark, upnl_coin: upnlCoin, settle_coin: coin,
        leverage: num(p.leverage) || null, liq: num(p.liquidationPrice) || null,
        notional: Math.abs(amt) * (coin === 'BTC' ? 100 : 10),
        stop: sl || null, tp: tp ? num(tp.stopPrice) : null, stop_refs: slOrders.map(o => o.ref),
        position_side: p.positionSide,
        opened_at: p.updateTime ? Math.floor(p.updateTime / 1000) : null,
      };
    });
    return { value, positions };
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

  // Solo se piden los precios de lo que se tiene: la lista completa pesa mucho
  // para descargarla cada minuto. equity() y el contexto comparten la lectura.
  let holdingsP = null;
  function spotHoldings(quiet = false) {
    holdingsP ||= readHoldings();
    return holdingsP.then(rows => rows.filter(h => h.value >= 1 || (!quiet && h.qty > 0 && !h.price)));
  }
  async function readHoldings() {
    const acct = await S('GET', '/api/v3/account', { omitZeroBalances: 'true' });
    const wanted = acct.balances.filter(b => !STABLES.has(b.asset) && num(b.free) + num(b.locked) > 0).map(b => b.asset + 'USDT');
    const px = await spotPx(wanted);
    return acct.balances.map(b => {
      const qty = num(b.free) + num(b.locked);
      const price = STABLES.has(b.asset) ? 1 : (px.get(b.asset + 'USDT') || 0);
      return { exchange: 'binance', market: 'spot', asset: b.asset, symbol: b.asset + 'USDT',
               qty, free: num(b.free), price, value: qty * price, stable: STABLES.has(b.asset) };
    });
  }

  async function instrument(market, symbol) {
    if (market === 'coinm') {
      const info = await exchangeInfo('coinm');
      const s = info.symbols.find(x => x.symbol === symbol);
      if (!s) throw new Error(`${symbol} no existe en Binance COIN-M (ej: BTCUSD_PERP)`);
      if ((s.contractStatus || s.status) !== 'TRADING') throw new Error(`${symbol} no esta operable en COIN-M`);
      const f = parseFilters(s, 0.0005);
      return { ...f, step: 1, min_qty: 1, contract_size: num(s.contractSize) || (symbol.startsWith('BTC') ? 100 : 10) };
    }
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
    if (market === 'coinm') { const d = await D('GET', '/dapi/v1/premiumIndex', { symbol }, false); return num((Array.isArray(d) ? d[0] : d)?.markPrice); }
    return num((await S('GET', '/api/v3/ticker/price', { symbol }, false)).price);
  }

  async function klines(market, symbol, interval = '5m', limit = 500) {
    const rows = market === 'futures' ? await F('GET', '/fapi/v1/klines', { symbol, interval, limit }, false)
      : market === 'coinm' ? await D('GET', '/dapi/v1/klines', { symbol, interval, limit: Math.min(limit, 1500) }, false)
      : await S('GET', '/api/v3/klines', { symbol, interval, limit }, false);
    return rows.map(r => ({ t: r[0], o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }));
  }

  // ── Futuros: ejecucion ─────────────────────────────────────────────────────

  async function placeStopAlgo(market, symbol, side, positionSide, kind, trigger, tick) {
    const { X, v } = fx(market);
    return X('POST', `${v}/algoOrder`, {
      algoType: 'CONDITIONAL', symbol,
      side: side === 'long' ? 'SELL' : 'BUY',
      positionSide: positionSide && positionSide !== 'BOTH' ? positionSide : undefined,
      type: kind, triggerPrice: fmt(roundTick(trigger, tick), tick),
      closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'true',
    });
  }

  // market: 'futures' (USDT-M, qty en moneda) o 'coinm' (COIN-M, qty en contratos)
  async function openFutures({ market = 'futures', symbol, side, qty, type, price: limitPrice, stop, tp, leverage, cid, inst }) {
    const { X, v } = fx(market);
    const hedge = await isDual(market);
    const positionSide = hedge ? (side === 'long' ? 'LONG' : 'SHORT') : undefined;
    try { await X('POST', `${v}/marginType`, { symbol, marginType: 'ISOLATED' }); }
    catch (e) { if (e.code !== -4046) throw e; }   // -4046: ya estaba en aislado
    await X('POST', `${v}/leverage`, { symbol, leverage });

    const order = await X('POST', `${v}/order`, {
      symbol, side: side === 'long' ? 'BUY' : 'SELL', positionSide,
      type: type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: fmt(qty, inst.step),
      price: type === 'limit' ? fmt(roundTick(limitPrice, inst.tick), inst.tick) : undefined,
      timeInForce: type === 'limit' ? 'GTC' : undefined,
      newClientOrderId: cid, newOrderRespType: 'RESULT',
    });

    // closePosition se puede dejar puesto antes de que entre la limite
    let stopErr = null, tpErr = null;
    try { await placeStopAlgo(market, symbol, side, positionSide, 'STOP_MARKET', stop, inst.tick); }
    catch (e) { stopErr = e.message; }
    if (tp) {
      try { await placeStopAlgo(market, symbol, side, positionSide, 'TAKE_PROFIT_MARKET', tp, inst.tick); }
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
    const market = pos.market === 'coinm' ? 'coinm' : 'futures';
    const { X, v } = fx(market);
    const inst = await instrument(market, pos.symbol);
    await placeStopAlgo(market, pos.symbol, pos.side, pos.position_side, 'STOP_MARKET', stop, inst.tick);
    for (const ref of pos.stop_refs || []) {
      try {
        if (ref.algoId) await X('DELETE', `${v}/algoOrder`, { algoId: ref.algoId });
        else await X('DELETE', `${v}/order`, { symbol: pos.symbol, orderId: ref.orderId });
      } catch (e) { console.error('cancel old stop', e.message); }
    }
  }

  async function reduce(pos, qty) {
    const market = pos.market === 'coinm' ? 'coinm' : 'futures';
    const { X, v } = fx(market);
    const inst = await instrument(market, pos.symbol);
    const hedge = pos.position_side && pos.position_side !== 'BOTH';
    const q = floorStep(Math.min(qty, pos.size), inst.step);
    if (!(q > 0)) return null;
    return X('POST', `${v}/order`, {
      symbol: pos.symbol, side: pos.side === 'long' ? 'SELL' : 'BUY',
      positionSide: hedge ? pos.position_side : undefined,
      reduceOnly: hedge ? undefined : 'true',
      type: 'MARKET', quantity: fmt(q, inst.step),
    });
  }

  const closePosition = pos => reduce(pos, pos.size);

  async function orderState(market, symbol, cid) {
    const o = market === 'spot'
      ? await S('GET', '/api/v3/order', { symbol, origClientOrderId: cid })
      : await fx(market).X('GET', `${fx(market).v}/order`, { symbol, origClientOrderId: cid });
    const map = { NEW: 'open', PARTIALLY_FILLED: 'partial', FILLED: 'filled' };
    return { state: map[o.status] || 'cancelled', filled_qty: num(o.executedQty), avg_price: num(o.avgPrice) || null };
  }

  async function cancelOrder(market, symbol, cid) {
    if (market === 'spot') return S('DELETE', '/api/v3/order', { symbol, origClientOrderId: cid });
    return fx(market).X('DELETE', `${fx(market).v}/order`, { symbol, origClientOrderId: cid });
  }

  // Los stops con closePosition pueden quedar vivos tras cerrar: se limpian
  async function cleanup(symbol, market = 'futures') {
    const { X, v } = fx(market);
    try { await X('DELETE', `${v}/algoOpenOrders`, { symbol }); } catch (e) { console.error('cleanup algo', e.message); }
  }

  // COIN-M liquida en la moneda: el PnL se pasa a USD al precio de salida
  async function closedPnl(symbol, side, sinceMs, market = 'futures') {
    const { X, v } = fx(market);
    const fills = await X('GET', `${v}/userTrades`, { symbol, startTime: sinceMs - 60000, limit: 1000 });
    const closing = side === 'long' ? 'SELL' : 'BUY';
    let pnl = 0, fees = 0, q = 0, notional = 0, last = 0;
    for (const f of fills) {
      pnl += num(f.realizedPnl);
      if (market === 'coinm' || f.commissionAsset === 'USDT' || f.commissionAsset === 'USDC') fees += num(f.commission);
      if (f.side === closing) { q += num(f.qty); notional += num(f.qty) * num(f.price); last = Math.max(last, f.time); }
    }
    const exit = q ? notional / q : null;
    const usd = market === 'coinm' ? (exit || 0) : 1;
    return { pnl: (pnl - fees) * usd, fees: fees * usd, exit_price: exit, closed_at: last ? Math.floor(last / 1000) : null };
  }

  // Posiciones de futuros cerradas desde sinceMs. userTrades exige simbolo y
  // como maximo 7 dias, asi que se piden solo los simbolos de la estrategia.
  async function closedHistory(sinceMs, symbols = ['BTCUSDT']) {
    const start = Math.max(sinceMs, Date.now() - 7 * 86400000 + 60000);
    const out = [];
    for (const symbol of symbols) {
      const fills = await F('GET', '/fapi/v1/userTrades', { symbol, startTime: start, limit: 1000 });
      out.push(...buildBinancePositions(fills).filter(t => t.exit_time && t.exit_time * 1000 >= sinceMs));
    }
    return out;
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
    spotStopOrders, spotPlaceStop, openSpot, spotClose, spotPnl, closedHistory, coinm,
    diag: async () => ({ futures: !!(await F('GET', '/fapi/v1/time', {}, false)).serverTime, hedge: await isDual() }),
  };
}
