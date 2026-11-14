// Bitget: futuros USDT-M y spot. Soporta las dos clases de cuenta:
//  - classic: API v2 (/api/v2/mix, /api/v2/spot)
//  - uta (cuenta unificada): API v3 (/api/v3/...)
// El modo se detecta al conectar con /api/v3/account/settings.
// Los datos publicos (instrumentos, velas, precios) van siempre por v3.

import { hmacRaw, base64, fmt, num, STABLES, sleep, listOf, xfetch, cachedPrices } from './common.js';
import { floorStep, roundTick } from '../risk.js';

const BASE = 'https://api.bitget.com';
const PT = 'USDT-FUTURES';

export function bitget({ key, secret, passphrase, mode = 'classic' }) {
  async function call(method, path, query = null, body = null, signed = true) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')) : '';
    const payload = body ? JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null && v !== ''))) : '';
    const headers = { 'Content-Type': 'application/json', locale: 'en-US' };
    if (signed) {
      const ts = String(Date.now());
      headers['ACCESS-KEY'] = key;
      headers['ACCESS-PASSPHRASE'] = passphrase;
      headers['ACCESS-TIMESTAMP'] = ts;
      headers['ACCESS-SIGN'] = base64(await hmacRaw(secret, ts + method + path + (qs === '?' ? '' : qs) + payload));
    }
    const res = await xfetch(BASE + path + (qs === '?' ? '' : qs), { method, headers, body: payload || undefined });
    const text = await res.text();
    let d; try { d = JSON.parse(text); } catch { d = { msg: text.slice(0, 200) }; }
    if (!res.ok || (d.code && d.code !== '00000')) {
      const err = new Error(`Bitget ${d.code ?? res.status}: ${d.msg ?? ''}`);
      err.code = d.code; err.status = res.status;
      throw err;
    }
    return d.data;
  }
  const get  = (p, q, s) => call('GET', p, q, null, s);
  const post = (p, b) => call('POST', p, null, b);
  const uta  = mode === 'uta';

  let holdMode = null;   // 'one_way' | 'hedge'
  async function hedge(symbol) {
    if (holdMode == null) {
      if (uta) {
        const s = await get('/api/v3/account/settings');
        holdMode = String(s.holdMode || '').includes('hedge') ? 'hedge' : 'one_way';
      } else {
        const a = await get('/api/v2/mix/account/account', { symbol: symbol || 'BTCUSDT', productType: PT, marginCoin: 'USDT' });
        holdMode = String(a.posMode || '').includes('hedge') ? 'hedge' : 'one_way';
      }
    }
    return holdMode === 'hedge';
  }

  // ── Publico ────────────────────────────────────────────────────────────────

  async function instrument(market, symbol) {
    const category = market === 'futures' ? PT : 'SPOT';
    const d = await get('/api/v3/market/instruments', { category, symbol }, false);
    const s = listOf(d)[0];
    if (!s) throw new Error(`${symbol} no existe en Bitget ${market}`);
    if (s.status && s.status !== 'online') throw new Error(`${symbol} no esta operable en Bitget (${s.status})`);
    const tick = num(s.priceMultiplier) || Math.pow(10, -num(s.pricePrecision));
    const step = num(s.quantityMultiplier) || Math.pow(10, -num(s.quantityPrecision));
    return {
      symbol, tick, step, min_qty: num(s.minOrderQty) || step, min_notional: num(s.minOrderAmount),
      fee: num(s.takerFeeRate) || (market === 'futures' ? 0.0006 : 0.001),
      max_leverage: num(s.maxLeverage) || null, base: s.baseCoin,
    };
  }

  async function price(market, symbol) {
    const d = await get('/api/v3/market/tickers', { category: market === 'futures' ? PT : 'SPOT', symbol }, false);
    const t = listOf(d)[0] || {};
    return num(t.markPrice) || num(t.lastPrice);
  }

  async function klines(market, symbol, interval = '5m', limit = 500) {
    const d = await get('/api/v3/market/candles', { category: market === 'futures' ? PT : 'SPOT', symbol, interval, limit: Math.min(limit, 1000) }, false);
    return listOf(d).map(r => ({ t: +r[0], o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) }))
      .sort((a, b) => a.t - b.t);
  }

  // Solo los simbolos que se tienen: la lista completa de Bitget pesa ~1.2 MB
  async function spotPrices(symbols) {
    if (!symbols.length) return new Map();
    return cachedPrices('bitget', symbols, async miss => {
      const got = await Promise.all(miss.map(async sym => {
        const d = await get('/api/v3/market/tickers', { category: 'SPOT', symbol: sym }, false).catch(() => null);
        const t = d ? listOf(d)[0] : null;
        return t ? [sym, num(t.lastPrice)] : null;
      }));
      return got.filter(Boolean);
    });
  }

  // ── Lectura privada ────────────────────────────────────────────────────────

  async function equity() {
    if (uta) {
      const a = await get('/api/v3/account/assets');
      const usdt = (a.assets || []).find(x => x.coin === 'USDT');
      const spot = (a.assets || []).filter(x => !STABLES.has(x.coin)).reduce((s, x) => s + num(x.usdValue), 0);
      const total = num(a.usdtEquity) || num(a.accountEquity);
      return { futures_equity: total - spot, futures_available: num(usdt?.available), spot_value: spot, total, errors: [] };
    }
    const [fut, spot] = await Promise.allSettled([get('/api/v2/mix/account/accounts', { productType: PT }), spotHoldings(true)]);
    if (fut.status === 'rejected' && spot.status === 'rejected') throw fut.reason;
    const acc = fut.status === 'fulfilled' ? listOf(fut.value).find(x => x.marginCoin === 'USDT') : null;
    const spotV = spot.status === 'fulfilled' ? spot.value.reduce((s, h) => s + h.value, 0) : 0;
    const futEq = num(acc?.usdtEquity) || num(acc?.accountEquity);
    return {
      futures_equity: futEq, futures_available: num(acc?.available), spot_value: spotV, total: futEq + spotV,
      errors: [fut, spot].filter(x => x.status === 'rejected').map(x => x.reason.message),
    };
  }

  // equity() y el contexto comparten la misma lectura
  let holdingsP = null;
  function spotHoldings(quiet = false) {
    holdingsP ||= readHoldings();
    return holdingsP.then(rows => rows.filter(h => h.value >= 1 || (!quiet && h.qty > 0 && !h.price)));
  }
  async function readHoldings() {
    let rows;
    if (uta) {
      const a = await get('/api/v3/account/assets');
      rows = (a.assets || []).map(x => ({ coin: x.coin, qty: num(x.equity) || num(x.balance), free: num(x.available) }));
    } else {
      rows = listOf(await get('/api/v2/spot/account/assets')).map(x => ({ coin: x.coin, qty: num(x.available) + num(x.frozen) + num(x.locked), free: num(x.available) }));
    }
    const px = await spotPrices(rows.filter(r => !STABLES.has(r.coin) && r.qty > 0).map(r => r.coin + 'USDT'));
    return rows.map(r => {
      const p = STABLES.has(r.coin) ? 1 : (px.get(r.coin + 'USDT') || 0);
      return { exchange: 'bitget', market: 'spot', asset: r.coin, symbol: r.coin + 'USDT', qty: r.qty, free: r.free,
               price: p, value: r.qty * p, stable: STABLES.has(r.coin) };
    });
  }

  async function stopOrders() {
    if (uta) {
      const d = await get('/api/v3/trade/unfilled-strategy-orders', { category: PT, type: 'tpsl' });
      return listOf(d).map(o => ({
        symbol: o.symbol, posSide: o.posSide, stop: num(o.stopLoss) || (o.triggerType === 'stopLoss' ? num(o.triggerPrice) : 0),
        tp: num(o.takeProfit) || (o.triggerType === 'takeProfit' ? num(o.triggerPrice) : 0), ref: { orderId: o.orderId },
      }));
    }
    const d = await get('/api/v2/mix/order/orders-plan-pending', { productType: PT, planType: 'profit_loss' });
    return listOf(d).map(o => {
      const isStop = ['pos_loss', 'loss_plan'].includes(o.planType);
      const isTp = ['pos_profit', 'profit_plan'].includes(o.planType);
      return { symbol: o.symbol, posSide: o.posSide, stop: isStop ? num(o.triggerPrice) : 0, tp: isTp ? num(o.triggerPrice) : 0,
               ref: { orderId: o.orderId, planType: o.planType } };
    });
  }

  async function futuresPositions() {
    const [rows, stops] = await Promise.all([
      uta ? get('/api/v3/position/current-position', { category: PT })
          : get('/api/v2/mix/position/all-position', { productType: PT, marginCoin: 'USDT' }),
      stopOrders().catch(e => { console.error('bitget stops', e.message); return []; }),
    ]);
    return listOf(rows).filter(p => num(p.total) > 0).map(p => {
      const side = (uta ? p.posSide : p.holdSide) === 'short' ? 'short' : 'long';
      const sameSym = stops.filter(s => s.symbol === p.symbol);
      // En modo one-way solo hay una posicion por simbolo; en hedge se filtra por lado
      const mine = sameSym.filter(s => !s.posSide || !['long', 'short'].includes(s.posSide) || s.posSide === side);
      const sl = mine.filter(s => s.stop > 0).sort((a, b) => side === 'long' ? b.stop - a.stop : a.stop - b.stop);
      const tp = mine.find(s => s.tp > 0);
      const entry = num(uta ? p.avgPrice : p.openPriceAvg);
      return {
        exchange: 'bitget', market: 'futures', symbol: p.symbol, side,
        size: num(p.total), entry, mark: num(p.markPrice),
        upnl: num(uta ? p.unrealisedPnl : p.unrealizedPL), liq: num(p.liquidationPrice) || null,
        leverage: num(p.leverage) || null, notional: num(p.total) * num(p.markPrice),
        stop: sl[0]?.stop || null, stop_refs: sl.map(s => s.ref), stop_tp: tp?.tp || null,
        tp: tp?.tp || null, margin_mode: p.marginMode,
        opened_at: Math.floor(num(uta ? p.createdTime : p.cTime) / 1000) || null,
      };
    });
  }

  // ── Futuros: ejecucion ─────────────────────────────────────────────────────

  async function openFutures({ symbol, side, qty, type, price: limitPrice, stop, tp, leverage, cid, inst }) {
    const isHedge = await hedge(symbol);
    const px = v => v ? fmt(roundTick(v, inst.tick), inst.tick) : undefined;
    let res;
    if (uta) {
      await post('/api/v3/account/set-leverage', { category: PT, symbol, leverage: String(leverage), marginMode: 'isolated',
        posSide: isHedge ? side : undefined }).catch(e => { if (!/leverage/i.test(e.message)) throw e; });
      res = await post('/api/v3/trade/place-order', {
        category: PT, symbol, qty: fmt(qty, inst.step), side: side === 'long' ? 'buy' : 'sell',
        posSide: isHedge ? side : undefined, orderType: type === 'limit' ? 'limit' : 'market',
        price: type === 'limit' ? px(limitPrice) : undefined, timeInForce: type === 'limit' ? 'gtc' : undefined,
        marginMode: 'isolated', clientOid: cid,
        stopLoss: px(stop), slTriggerBy: 'mark', takeProfit: px(tp), tpTriggerBy: tp ? 'mark' : undefined,
      });
    } else {
      // set-margin-mode falla si ya hay posicion u ordenes en ese simbolo; no es grave
      await post('/api/v2/mix/account/set-margin-mode', { symbol, productType: PT, marginCoin: 'USDT', marginMode: 'isolated' })
        .catch(e => console.error('bitget margin mode', e.message));
      await post('/api/v2/mix/account/set-leverage', { symbol, productType: PT, marginCoin: 'USDT', leverage: String(leverage),
        holdSide: isHedge ? side : undefined });
      res = await post('/api/v2/mix/order/place-order', {
        symbol, productType: PT, marginMode: 'isolated', marginCoin: 'USDT',
        size: fmt(qty, inst.step), side: side === 'long' ? 'buy' : 'sell',
        tradeSide: isHedge ? 'open' : undefined, orderType: type === 'limit' ? 'limit' : 'market',
        price: type === 'limit' ? px(limitPrice) : undefined, force: 'gtc', clientOid: cid,
        presetStopLossPrice: px(stop), presetStopSurplusPrice: px(tp),
      });
    }
    // El stop va adjunto a la orden: si la orden se acepto, el stop tambien.
    // Igual se verifica despues de entrar (ver gateway).
    return { order_id: String(res?.orderId || ''), filled: type !== 'limit', avg_price: null, stop_error: null, tp_error: null };
  }

  async function setStop(pos, stop) {
    const inst = await instrument('futures', pos.symbol);
    const p = fmt(roundTick(stop, inst.tick), inst.tick);
    const isHedge = await hedge(pos.symbol);
    if (uta) {
      // Se crea el nuevo (conservando el TP si habia) y luego se cancela el viejo
      await post('/api/v3/trade/place-strategy-order', {
        category: PT, symbol: pos.symbol, type: 'tpsl', tpslMode: 'full', posSide: pos.side,
        marginMode: pos.margin_mode || 'isolated', stopLoss: p, slTriggerBy: 'mark',
        takeProfit: pos.stop_tp ? fmt(roundTick(pos.stop_tp, inst.tick), inst.tick) : undefined,
        tpTriggerBy: pos.stop_tp ? 'mark' : undefined,
      });
      for (const ref of pos.stop_refs || []) {
        await post('/api/v3/trade/cancel-strategy-order', { orderId: ref.orderId }).catch(e => console.error('bitget cancel sl', e.message));
      }
      return;
    }
    const posStop = (pos.stop_refs || []).find(r => r.planType === 'pos_loss');
    if (posStop) {
      await post('/api/v2/mix/order/modify-tpsl-order', {
        orderId: posStop.orderId, marginCoin: 'USDT', productType: PT, symbol: pos.symbol,
        triggerPrice: p, triggerType: 'mark_price', size: '',
      });
      return;
    }
    await post('/api/v2/mix/order/place-tpsl-order', {
      marginCoin: 'USDT', productType: PT, symbol: pos.symbol, planType: 'pos_loss',
      triggerPrice: p, triggerType: 'mark_price',
      holdSide: isHedge ? pos.side : (pos.side === 'long' ? 'buy' : 'sell'),
    });
  }

  async function reduce(pos, qty) {
    const inst = await instrument('futures', pos.symbol);
    const q = floorStep(Math.min(qty, pos.size), inst.step);
    if (!(q > 0)) return null;
    const isHedge = await hedge(pos.symbol);
    if (uta) {
      return post('/api/v3/trade/place-order', {
        category: PT, symbol: pos.symbol, qty: fmt(q, inst.step), orderType: 'market',
        side: pos.side === 'long' ? 'sell' : 'buy',
        posSide: isHedge ? pos.side : undefined, reduceOnly: isHedge ? undefined : 'yes',
      });
    }
    // v2 hedge: side es la direccion de la posicion y tradeSide=close
    return post('/api/v2/mix/order/place-order', {
      symbol: pos.symbol, productType: PT, marginMode: pos.margin_mode || 'isolated', marginCoin: 'USDT',
      size: fmt(q, inst.step), orderType: 'market',
      side: isHedge ? (pos.side === 'long' ? 'buy' : 'sell') : (pos.side === 'long' ? 'sell' : 'buy'),
      tradeSide: isHedge ? 'close' : undefined, reduceOnly: isHedge ? undefined : 'YES',
    });
  }

  async function closePosition(pos) {
    if (uta) return post('/api/v3/trade/close-positions', { category: PT, symbol: pos.symbol, posSide: pos.side });
    const isHedge = await hedge(pos.symbol);
    return post('/api/v2/mix/order/close-positions', { symbol: pos.symbol, productType: PT, holdSide: isHedge ? pos.side : undefined });
  }

  async function orderState(market, symbol, cid) {
    if (uta) {
      const o = await get('/api/v3/trade/order-info', { clientOid: cid });
      const s = String(o.orderStatus || '').toLowerCase();
      return { state: s === 'filled' ? 'filled' : s.includes('partial') ? 'partial' : (s === 'live' || s === 'new') ? 'open' : 'cancelled',
               filled_qty: num(o.cumExecQty), avg_price: num(o.avgPrice) || null };
    }
    if (market === 'futures') {
      const o = await get('/api/v2/mix/order/detail', { symbol, productType: PT, clientOid: cid });
      const s = o.state;
      return { state: s === 'filled' ? 'filled' : s === 'partially_filled' ? 'partial' : s === 'live' ? 'open' : 'cancelled',
               filled_qty: num(o.baseVolume), avg_price: num(o.priceAvg) || null };
    }
    const o = listOf(await get('/api/v2/spot/trade/orderInfo', { clientOid: cid }))[0] || {};
    return { state: o.status === 'filled' ? 'filled' : o.status === 'partially_filled' ? 'partial' : o.status === 'live' ? 'open' : 'cancelled',
             filled_qty: num(o.baseVolume), avg_price: num(o.priceAvg) || null };
  }

  async function cancelOrder(market, symbol, cid) {
    if (uta) return post('/api/v3/trade/cancel-order', { clientOid: cid, category: market === 'futures' ? PT : 'SPOT', symbol });
    if (market === 'futures') return post('/api/v2/mix/order/cancel-order', { symbol, productType: PT, clientOid: cid });
    return post('/api/v2/spot/trade/cancel-order', { symbol, clientOid: cid });
  }

  async function cleanup() { /* el TP/SL de posicion desaparece con la posicion */ }

  async function closedPnl(symbol, side, sinceMs) {
    const d = uta
      ? await get('/api/v3/position/history-position', { category: PT, symbol, startTime: String(sinceMs - 60000) })
      : await get('/api/v2/mix/position/history-position', { productType: PT, symbol, startTime: String(sinceMs - 60000) });
    const rows = listOf(d).filter(p => (uta ? p.posSide : p.holdSide) === side);
    if (!rows.length) return null;
    const pnl = rows.reduce((s, p) => s + num(p.netProfit), 0);
    const last = rows.reduce((m, p) => Math.max(m, num(uta ? p.updatedTime : p.uTime)), 0);
    const exit = num(uta ? rows[0].closePriceAvg : rows[0].closeAvgPrice) || null;
    return { pnl, exit_price: exit, closed_at: last ? Math.floor(last / 1000) : null };
  }

  // Posiciones de futuros cerradas desde sinceMs, hechas por el terminal o por
  // fuera. Las usa el journal para no perder operaciones.
  async function closedHistory(sinceMs) {
    const d = uta
      ? await get('/api/v3/position/history-position', { category: PT, startTime: String(sinceMs), limit: '100' })
      : await get('/api/v2/mix/position/history-position', { productType: PT, startTime: String(sinceMs), limit: '100' });
    return listOf(d).map(p => ({
      symbol: p.symbol, category: 'linear',
      side: (uta ? p.posSide : p.holdSide) === 'short' ? 'short' : 'long',
      entry_price: num(uta ? p.openPriceAvg : p.openAvgPrice),
      exit_price: num(uta ? p.closePriceAvg : p.closeAvgPrice) || null,
      size: num(p.closeTotalPos) || num(p.openTotalPos),
      pnl: num(p.netProfit),
      fees: Math.abs(num(uta ? p.openFeeTotal : p.openFee)) + Math.abs(num(uta ? p.closeFeeTotal : p.closeFee)),
      entry_time: Math.floor(num(uta ? p.createdTime : p.cTime) / 1000),
      exit_time: Math.floor(num(uta ? p.updatedTime : p.uTime) / 1000),
      exchange: 'bitget', exchange_id: String(p.positionId),
    })).filter(t => t.entry_price > 0 && t.exit_time > 0);
  }

  // ── Spot ───────────────────────────────────────────────────────────────────

  async function spotStopOrders(symbol) {
    if (uta) {
      const d = await get('/api/v3/trade/unfilled-strategy-orders', { category: 'SPOT' });
      return listOf(d).filter(o => o.symbol === symbol && o.side === 'sell');
    }
    const d = await get('/api/v2/spot/trade/current-plan-order', { symbol });
    return listOf(d).filter(o => o.side === 'sell');
  }

  async function spotPlaceStop(symbol, qty, stop, tp, inst) {
    inst ||= await instrument('spot', symbol);
    const q = fmt(floorStep(qty, inst.step), inst.step);
    const trig = v => fmt(roundTick(v, inst.tick), inst.tick);
    const plan = trigger => uta
      ? post('/api/v3/trade/place-strategy-order', { category: 'SPOT', symbol, type: 'trigger', side: 'sell', qty: q,
          triggerPrice: trig(trigger), triggerBy: 'market', triggerOrderType: 'market' })
      : post('/api/v2/spot/trade/place-plan-order', { symbol, side: 'sell', triggerPrice: trig(trigger), orderType: 'market',
          size: q, triggerType: 'fill_price', planType: 'amount' });
    await plan(stop);
    if (tp) await plan(tp).catch(e => console.error('bitget spot tp', e.message));
  }

  async function openSpot({ symbol, qty, stop, tp, cid, inst, ref_price }) {
    // Compra limite IOC un poco por encima: la cantidad va en moneda base y no
    // hay sorpresas de precio (la de mercado en Bitget va en USDT).
    const limit = fmt(roundTick(ref_price * 1.003, inst.tick), inst.tick);
    const res = uta
      ? await post('/api/v3/trade/place-order', { category: 'SPOT', symbol, qty: fmt(qty, inst.step), side: 'buy',
          orderType: 'limit', price: limit, timeInForce: 'ioc', clientOid: cid })
      : await post('/api/v2/spot/trade/place-order', { symbol, side: 'buy', orderType: 'limit', force: 'ioc',
          price: limit, size: fmt(qty, inst.step), clientOid: cid });
    await sleep(800);
    const st = await orderState('spot', symbol, cid).catch(() => null);
    const holdings = await readHoldings();   // lectura fresca tras comprar
    const free = holdings.find(h => h.asset === inst.base)?.free || 0;
    const filled = floorStep(Math.min(free, st?.filled_qty || qty), inst.step);
    let stopErr = null;
    if (filled > 0) {
      try { await spotPlaceStop(symbol, filled, stop, tp, inst); } catch (e) { stopErr = e.message; }
    }
    return { order_id: String(res?.orderId || ''), filled: filled > 0, filled_qty: filled, avg_price: st?.avg_price || ref_price, stop_error: stopErr };
  }

  async function spotClose(symbol) {
    const inst = await instrument('spot', symbol);
    for (const o of await spotStopOrders(symbol).catch(() => [])) {
      await (uta ? post('/api/v3/trade/cancel-strategy-order', { orderId: o.orderId })
                 : post('/api/v2/spot/trade/cancel-plan-order', { orderId: o.orderId })).catch(() => {});
    }
    const free = (await readHoldings()).find(h => h.asset === inst.base)?.free || 0;
    const q = floorStep(free, inst.step);
    if (!(q > 0)) return null;
    const px = await price('spot', symbol);
    const limit = fmt(roundTick(px * 0.997, inst.tick), inst.tick);
    return uta
      ? post('/api/v3/trade/place-order', { category: 'SPOT', symbol, qty: fmt(q, inst.step), side: 'sell', orderType: 'limit', price: limit, timeInForce: 'ioc' })
      : post('/api/v2/spot/trade/place-order', { symbol, side: 'sell', orderType: 'limit', force: 'ioc', price: limit, size: fmt(q, inst.step) });
  }

  async function spotPnl() { return null; }   // se completa a mano en el journal

  async function diag() {
    await get('/api/v3/market/tickers', { category: PT, symbol: 'BTCUSDT' }, false);
    return { mode, hedge: await hedge('BTCUSDT') };
  }

  return {
    name: 'bitget', equity, futuresPositions, spotHoldings, instrument, price, klines,
    openFutures, setStop, reduce, closePosition, orderState, cancelOrder, cleanup, closedPnl,
    spotStopOrders, spotPlaceStop, openSpot, spotClose, spotPnl, diag, closedHistory,
  };
}

// Cuenta clasica o unificada. Una llave clasica que pide settings v3 recibe error.
export async function detectBitgetMode(creds) {
  const ts = String(Date.now());
  const path = '/api/v3/account/settings';
  const sign = base64(await hmacRaw(creds.secret, ts + 'GET' + path));
  const res = await xfetch(BASE + path, { headers: {
    'ACCESS-KEY': creds.key, 'ACCESS-PASSPHRASE': creds.passphrase, 'ACCESS-TIMESTAMP': ts,
    'ACCESS-SIGN': sign, 'Content-Type': 'application/json', locale: 'en-US',
  } });
  const d = await res.json().catch(() => ({}));
  if (d.code === '00000' && d.data?.accountMode === 'unified') return 'uta';
  return 'classic';
}
