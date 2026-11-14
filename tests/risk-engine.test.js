import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRules, splitChange, sessionWindow, newsStatus, parseCalendar, validateOrder, evaluateGates,
  lockFromGates, sizeOrder, chooseLeverage, guardianPlan, todayStats, nyParts, weekStart, DEFAULT_RULES, floorStep,
} from '../workers/trade-journal-worker/src/risk.js';
import { vwapBands, rsi, stochRsi, snapshot, utcAnchor } from '../workers/trade-journal-worker/src/indicators.js';
import { afterHoursAdvice } from '../workers/trade-journal-worker/src/gateway.js';

const R = normalizeRules(DEFAULT_RULES);
// Martes 2026-11-10, NY en horario estandar (UTC-5)
const ny = (h, m = 0, day = 10) => Date.UTC(2026, 10, day, h + 5, m);

test('los limites duros no se pueden superar', () => {
  const r = normalizeRules({ risk_pct: 5, max_open_risk_pct: 10, leverage: 100, max_margin_pct: 50, cooldown_min: 0, pre_open_min: 180 });
  assert.equal(r.risk_pct, 2);
  assert.equal(r.max_open_risk_pct, 2);
  assert.equal(r.leverage, 51);
  assert.equal(r.max_margin_pct, 10);
  assert.equal(normalizeRules({ max_leverage: 10 }).max_leverage, undefined);
  assert.equal(r.cooldown_min, 15);
  assert.equal(r.pre_open_min, 60);
  // el riesgo por operacion no supera el riesgo total
  assert.equal(normalizeRules({ risk_pct: 1.5, max_open_risk_pct: 1 }).risk_pct, 1);
});

test('aflojar espera, endurecer aplica ya', () => {
  const next = normalizeRules({ ...R, risk_pct: 0.5, min_rr: 1.2, cooldown_min: 60, block_news: false });
  const { tighter, looser } = splitChange(R, next);
  assert.deepEqual(Object.keys(tighter).sort(), ['cooldown_min', 'risk_pct']);
  assert.deepEqual(Object.keys(looser).sort(), ['block_news', 'min_rr']);
  // quitar un punto del checklist afloja; agregar endurece
  assert.ok(splitChange(R, { ...R, checklist: R.checklist.slice(1) }).looser.checklist);
  assert.ok(splitChange(R, { ...R, checklist: [...R.checklist, 'nuevo'] }).tighter.checklist);
  // pasar de lista de simbolos a "todos" afloja
  const withSyms = { ...R, symbols: ['BTCUSDT'] };
  assert.ok(splitChange(withSyms, { ...withSyms, symbols: [] }).looser.symbols);
  assert.ok(splitChange({ ...R, symbols: [] }, withSyms).tighter.symbols);
  // agregar otro simbolo a la lista tambien afloja
  assert.ok(splitChange(withSyms, { ...withSyms, symbols: ['BTCUSDT', 'ETHUSDT'] }).looser.symbols);
});

test('ventana: 1h antes de la apertura hasta 1h despues del cierre, en hora NY', () => {
  assert.equal(sessionWindow(ny(8, 29), R).in_window, false);
  assert.equal(sessionWindow(ny(8, 30), R).in_window, true);
  assert.equal(sessionWindow(ny(16, 59), R).in_window, true);
  assert.equal(sessionWindow(ny(17, 0), R).in_window, false);
  // horario de verano: julio es UTC-4
  assert.equal(sessionWindow(Date.UTC(2026, 6, 14, 12, 30), R).in_window, true);   // 08:30 NY
  assert.equal(sessionWindow(Date.UTC(2026, 6, 14, 12, 29), R).in_window, false);
  // fin de semana y feriado
  assert.equal(sessionWindow(ny(10, 0, 14), R).trading_day, false);   // sabado
  assert.equal(sessionWindow(ny(10, 0, 26), R).trading_day, false);   // Thanksgiving
  // cierre temprano: viernes despues de Thanksgiving cierra 13:00 -> ventana hasta 14:00
  assert.equal(sessionWindow(ny(14, 0, 27), R).in_window, false);
  assert.equal(sessionWindow(ny(13, 59, 27), R).in_window, true);
});

test('nyParts y weekStart', () => {
  assert.equal(nyParts(ny(23, 30)).date, '2026-11-10');
  assert.equal(weekStart('2026-11-13'), '2026-11-09');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekStart('2026-11-15'), '2026-11-09');
});

test('calendario: solo USD alto impacto; sin calendario se bloquea', () => {
  const { events, coverage } = parseCalendar([
    { title: 'CPI m/m', country: 'USD', date: '2026-11-12T08:30:00-05:00', impact: 'High' },
    { title: 'Retail', country: 'USD', date: '2026-11-13T08:30:00-05:00', impact: 'Medium' },
    { title: 'GDP', country: 'GBP', date: '2026-11-13T02:00:00-05:00', impact: 'High' },
    { title: 'Speech', country: 'AUD', date: '2026-11-08T17:30:00-05:00', impact: 'Low' },
  ]);
  assert.deepEqual(events, [{ date: '2026-11-12', title: 'CPI m/m', time: '08:30' }]);
  assert.deepEqual(coverage, { from: '2026-11-08', to: '2026-11-14' });
  assert.equal(newsStatus('2026-11-12', events, coverage).blocked, true);
  assert.equal(newsStatus('2026-11-13', events, coverage).blocked, false);
  const unknown = newsStatus('2026-11-16', events, coverage);
  assert.equal(unknown.blocked, true);
  assert.equal(unknown.unknown, true);
  assert.equal(newsStatus('2026-11-16', events, coverage, true).blocked, false);
});

test('validacion: stop obligatorio, lados correctos, R:R minimo, checklist completo', () => {
  const ok = { symbol: 'BTCUSDT', side: 'long', market: 'futures', entry: 100, stop: 98, tp: 104, checklist: R.checklist };
  assert.deepEqual(validateOrder(ok, R).errs, []);
  assert.equal(validateOrder(ok, R).rr, 2);
  assert.match(validateOrder({ ...ok, stop: 0 }, R).errs.join(), /obligatorio/);
  assert.match(validateOrder({ ...ok, stop: 101 }, R).errs.join(), /por debajo/);
  assert.match(validateOrder({ ...ok, tp: 102 }, R).errs.join(), /R:R/);
  assert.match(validateOrder({ ...ok, checklist: [] }, R).errs.join(), /Checklist/);
  assert.match(validateOrder({ ...ok, market: 'spot', side: 'short', stop: 102, tp: 96 }, R).errs.join(), /spot/);
});

const baseCtx = (o = {}) => ({
  now: ny(10), rules: R, window: sessionWindow(ny(10), R), news: { blocked: false }, lock: null,
  equity: { now: 1000, day_start: 1000, week_start: 1000 }, open: [],
  today: { trades: 0, consec_losses: 0, last_loss_at: null }, ...o,
});

test('compuertas: todo en orden da 1% de riesgo', () => {
  const g = evaluateGates(baseCtx());
  assert.equal(g.ok, true);
  assert.equal(g.risk_pct, 1);
  assert.equal(g.risk_usd, 10);
});

test('compuertas: cada regla bloquea', () => {
  const codes = ctx => evaluateGates(baseCtx(ctx)).blocks.map(b => b.code);
  assert.ok(codes({ window: sessionWindow(ny(7), R) }).includes('window'));
  assert.ok(codes({ news: { blocked: true, reason: 'CPI' } }).includes('news'));
  assert.ok(codes({ lock: { until: ny(23) / 1000, reason: 'x' } }).includes('lock'));
  assert.ok(codes({ today: { trades: 3, consec_losses: 0 } }).includes('max_trades'));
  assert.ok(codes({ today: { trades: 2, consec_losses: 2 } }).includes('consec'));
  assert.ok(codes({ today: { trades: 1, consec_losses: 1, last_loss_at: ny(9, 50) / 1000 } }).includes('cooldown'));
  assert.ok(!codes({ today: { trades: 1, consec_losses: 1, last_loss_at: ny(9, 20) / 1000 } }).includes('cooldown'));
  assert.ok(codes({ equity: { now: 965, day_start: 1000, week_start: 1000 } }).includes('daily_loss'));
  assert.ok(codes({ open: [{ risk_usd: 10 }, { risk_usd: 10 }] }).includes('max_positions'));
});

test('presupuesto: el riesgo abierto y la perdida del dia recortan la siguiente operacion', () => {
  // 1.5% abierto -> quedan 0.5% del maximo de 2%
  assert.equal(evaluateGates(baseCtx({ open: [{ risk_usd: 15 }] })).risk_pct, 0.5);
  // perdiste 2.5% hoy: si el nuevo stop salta no puedes pasar del 3% diario
  const g = evaluateGates(baseCtx({ equity: { now: 975, day_start: 1000, week_start: 1000 } }));
  assert.equal(g.risk_pct, 0.5);
  // la base es el menor capital: ganar en el dia no sube el riesgo
  assert.equal(evaluateGates(baseCtx({ equity: { now: 1200, day_start: 1000, week_start: 1000 } })).risk_usd, 10);
  // sin presupuesto suficiente se bloquea
  assert.ok(evaluateGates(baseCtx({ open: [{ risk_usd: 19 }] })).blocks.some(b => b.code === 'budget'));
});

test('bloqueo del dia por perdida diaria o racha', () => {
  const g = evaluateGates(baseCtx({ equity: { now: 965, day_start: 1000, week_start: 1000 } }));
  assert.equal(lockFromGates(g, R).scope, 'day');
  const w = evaluateGates(baseCtx({ equity: { now: 935, day_start: 940, week_start: 1000 } }));
  assert.equal(lockFromGates(w, R).scope, 'week');
  assert.equal(lockFromGates(evaluateGates(baseCtx()), R), null);
});

test('tamano: sale del riesgo, incluye comisiones y redondea hacia abajo', () => {
  const s = sizeOrder({ risk_usd: 10, entry: 100, stop: 98, step: 0.001, fee_rate: 0.0006 });
  assert.ok(s.risk_usd <= 10);
  assert.ok(s.risk_usd > 9.5);
  assert.equal(s.qty, floorStep(s.qty, 0.001));
  // el valor minimo del exchange no se alcanza
  assert.match(sizeOrder({ risk_usd: 1, entry: 60000, stop: 59000, step: 0.001, min_qty: 0.001 }).error, /minimo/);
});

test('tope de margen: con stop corto manda el 10% a 51x y se arriesga menos', () => {
  // riesgo 10 USDT, stop a 0.05%: por riesgo serian ~0.08 BTC; el tope 5100/60000 = 0.085
  const wide = sizeOrder({ risk_usd: 10, entry: 60000, stop: 59700, step: 0.001, fee_rate: 0.0006, max_notional: 5100 });
  assert.equal(wide.capped_by_margin, false);
  const tight = sizeOrder({ risk_usd: 20, entry: 60000, stop: 59950, step: 0.001, fee_rate: 0, slippage: 0, max_notional: 5100 });
  assert.equal(tight.capped_by_margin, true);
  assert.ok(tight.notional <= 5100);
  assert.ok(tight.risk_usd < 20);
});

test('apalancamiento fijo, margen disponible y liquidacion mas lejos que el stop', () => {
  // ejemplo del usuario: cuenta 1000, 10% a 51x = 5100 de posicion, margen 100
  const l = chooseLeverage({ notional: 5100, available: 1000, leverage: 51, stop_dist_pct: 0.3 });
  assert.equal(l.leverage, 51);
  assert.equal(l.margin, 100);
  assert.match(chooseLeverage({ notional: 5100, available: 50, leverage: 51, stop_dist_pct: 0.3 }).error, /margen/);
  // a 51x la liquidacion queda a ~1.46%: un stop de 1.5% no es valido
  assert.match(chooseLeverage({ notional: 5100, available: 1000, leverage: 51, stop_dist_pct: 1.5 }).error, /liquidacion/);
});

const pos = (o = {}) => ({ exchange: 'binance', market: 'futures', symbol: 'BTCUSDT', side: 'long', size: 1, entry: 100, mark: 101, stop: 99, ...o });
const led = (o = {}) => ({ id: 't1', exchange: 'binance', market: 'futures', symbol: 'BTCUSDT', side: 'long', qty: 1, stop: 99, status: 'open', opened_at: 0, ...o });
const plan = (positions, ledger, ok = true) => guardianPlan({ positions, ledger, tradingAllowed: { ok, reason: 'fuera de ventana' }, rules: R, baseEquity: 1000, now: 1e12 });

test('guardian: todo en regla no hace nada', () => {
  assert.deepEqual(plan([pos()], [led()]), []);
});

test('guardian: repone el stop, devuelve el stop alejado, recorta tamano', () => {
  assert.equal(plan([pos({ stop: null })], [led()])[0].type, 'set_stop');
  const moved = plan([pos({ stop: 95 })], [led()])[0];
  assert.equal(moved.type, 'set_stop');
  assert.equal(moved.stop, 99);
  // acercar el stop (a favor) esta permitido
  assert.deepEqual(plan([pos({ stop: 99.5 })], [led()]), []);
  const added = plan([pos({ size: 2 })], [led()])[0];
  assert.equal(added.type, 'reduce');
  assert.equal(added.qty, 1);
  // stop alejado y el precio ya lo cruzo: se cierra
  assert.equal(plan([pos({ stop: 95, mark: 98 })], [led()])[0].type, 'close');
});

test('guardian: posicion externa se cierra si no se podia operar, si no se adopta', () => {
  assert.equal(plan([pos()], [], false)[0].type, 'close');
  assert.equal(plan([pos()], [], true)[0].type, 'adopt');
  // externa sin stop: stop de emergencia al riesgo maximo
  const a = plan([pos({ stop: null })], [], true);
  assert.equal(a[1].type, 'set_stop');
  assert.equal(a[1].stop, 90);   // 1% de 1000 = 10 USDT / 1 unidad
});

test('guardian: posicion por encima del tope de margen se recorta', () => {
  // cuenta 1000: tope 5100 de valor. 80 unidades a 100 = 8000
  const a = plan([pos({ size: 80, stop: 99.9 })], [led({ qty: 80, stop: 99.9 })]);
  assert.equal(a[0].type, 'reduce');
  assert.match(a[0].reason, /margen/);
});

test('guardian: posicion externa en un simbolo fuera de la estrategia se cierra', () => {
  const a = plan([pos({ symbol: 'ETHUSDT' })], [], true);
  assert.equal(a[0].type, 'close');
  assert.match(a[0].reason, /no esta en tu estrategia/);
  assert.deepEqual(R.symbols, ['BTCUSDT']);
});

test('guardian: riesgo mayor al 2% se recorta', () => {
  const a = plan([pos({ size: 10, stop: 97 })], [led({ qty: 10, stop: 97 })]);
  assert.equal(a[0].type, 'reduce');
  assert.ok(a[0].qty > 0);
});

test('guardian: operacion del libro sin posicion queda cerrada; la limite pendiente se revisa', () => {
  assert.equal(plan([], [led()])[0].type, 'closed');
  assert.equal(plan([], [led({ status: 'pending' })], false)[0].cancel, true);
});

test('estadisticas del dia: racha de perdidas desde el final', () => {
  const day = d => d;
  const t = (o) => ({ status: 'closed', opened_at: 1, closed_at: o.c, pnl: o.p, risk_usd: 10 });
  const s = todayStats([t({ c: 1, p: -10 }), t({ c: 2, p: 20 }), t({ c: 3, p: -10 }), t({ c: 4, p: -9 })], 'x', () => 'x');
  assert.equal(s.trades, 4);
  assert.equal(s.consec_losses, 2);
  assert.equal(s.last_loss_at, 4);
  // un scratch (-0.1R) no cuenta como perdida
  assert.equal(todayStats([t({ c: 1, p: -1 })], 'x', () => 'x').consec_losses, 0);
  void day;
});

test('VWAP: con volumen constante es el promedio del precio tipico y se reinicia en el ancla', () => {
  const k = (t, p) => ({ t, o: p, h: p, l: p, c: p, v: 1 });
  const b = vwapBands([k(0, 10), k(1, 20), k(86400000, 50)], utcAnchor);
  assert.equal(b[1].vwap, 15);
  assert.equal(b[1].sd, 5);
  assert.equal(b[2].vwap, 50);
});

test('RSI y RSI estocastico en rango', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.05);
  const r = rsi(closes, 6).filter(x => x != null);
  assert.ok(r.every(x => x >= 0 && x <= 100));
  const st = stochRsi(closes);
  assert.ok(st.k.filter(x => x != null).every(x => x >= 0 && x <= 100));
  // solo subidas -> RSI 100
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8], 6)[7], 100);
  const snap = snapshot(closes.map((c, i) => ({ t: i * 60000, o: c, h: c + 1, l: c - 1, c, v: 10 })), utcAnchor);
  assert.equal(snap.bands.length, 3);
  assert.ok(snap.rsi6 >= 0 && snap.rsi6 <= 100);
});

test('fuera de la ventana con posicion abierta se recomienda cerrar', () => {
  const p = [{ symbol: 'BTCUSDT', side: 'long' }];
  assert.equal(afterHoursAdvice(sessionWindow(ny(10), R), p), null);
  assert.equal(afterHoursAdvice(sessionWindow(ny(16, 50), R), p).level, 'soon');
  assert.equal(afterHoursAdvice(sessionWindow(ny(18), R), p).level, 'closed');
  assert.equal(afterHoursAdvice(sessionWindow(ny(18), R), []), null);
});

import { checkOutsideTerminal } from '../workers/trade-journal-worker/src/insights.js';
test('insight: operaciones fuera del terminal', () => {
  const t = (exec_type, pnl) => ({ exec_type, pnl, status: 'closed' });
  assert.deepEqual(checkOutsideTerminal([t('terminal', 5), t('bot', -3)]), []);
  const r = checkOutsideTerminal([t('terminal', 5), t('terminal', 3), t('external', -8)]);
  assert.equal(r[0].severity, 'critical');
  assert.match(r[0].title, /1 operacion fuera/);
});
