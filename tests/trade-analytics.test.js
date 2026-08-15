import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, groupByDimension, buildWeeklyReview, riskOf, rMultiple }
  from '../workers/trade-journal-worker/src/analytics.js';

const DAY = 86400;
// Lunes 2023-11-13 00:00 UTC
const MON = Date.UTC(2023, 10, 13) / 1000;

const trade = (o = {}) => ({
  status: 'closed', symbol: 'BTCUSDT', side: 'long',
  entry_price: 100, size: 1, pnl: 10, fees: 0.1,
  entry_time: MON + 3600, exit_time: MON + 7200, ...o,
});

test('riskOf usa risk_usd si esta, si no lo deriva del stop', () => {
  assert.equal(riskOf(trade({ risk_usd: 25 })), 25);
  assert.equal(riskOf(trade({ stop_price: 95, size: 2 })), 10);
  assert.equal(riskOf(trade()), null);
  // un stop igual a la entrada no es riesgo valido
  assert.equal(riskOf(trade({ stop_price: 100 })), null);
});

test('rMultiple divide el pnl por el riesgo', () => {
  assert.equal(rMultiple(trade({ stop_price: 95, pnl: 15 })), 3);
  assert.equal(rMultiple(trade({ stop_price: 95, pnl: -5 })), -1);
  assert.equal(rMultiple(trade({ pnl: 15 })), null);
});

test('las metricas en R solo cuentan los trades con stop', () => {
  const s = computeStats([
    trade({ stop_price: 95, pnl: 10 }),   // +2R
    trade({ stop_price: 95, pnl: -5 }),   // -1R
    trade({ pnl: 100 }),                  // sin stop, no entra en R
    trade({ pnl: 100 }),
  ]);
  assert.equal(s.rCount, 2);
  assert.equal(s.rCoverage, 50);
  assert.equal(s.totalR, 1);
  assert.equal(s.avgR, 0.5);
  assert.equal(s.bestR, 2);
  assert.equal(s.worstR, -1);
  // el PnL en dinero sigue contando todos
  assert.equal(s.totalPnl, 205);
});

test('sin ningun stop las metricas en R quedan en cero, no en NaN', () => {
  const s = computeStats([trade(), trade({ pnl: -5 })]);
  assert.equal(s.rCount, 0);
  assert.equal(s.avgR, 0);
  assert.ok(Number.isFinite(s.totalR));
});

test('groupByDimension expone avgR por grupo', () => {
  const data = groupByDimension([
    trade({ setup_tag: 'OB', stop_price: 95, pnl: 20 }),  // +4R
    trade({ setup_tag: 'OB', stop_price: 95, pnl: -5 }),  // -1R
    trade({ setup_tag: 'FVG', pnl: 5 }),
  ], 'setup_tag');

  const ob  = data.find(d => d.label === 'OB');
  const fvg = data.find(d => d.label === 'FVG');
  assert.equal(ob.avgR, 1.5);
  assert.equal(ob.totalR, 3);
  assert.equal(fvg.avgR, null, 'sin stop no hay R que promediar');
});

test('el review semanal agrupa por semana empezando el lunes', () => {
  const weeks = buildWeeklyReview([
    trade({ entry_time: MON + 3600, pnl: 10 }),           // lunes
    trade({ entry_time: MON + 6 * DAY, pnl: -4 }),        // domingo, misma semana
    trade({ entry_time: MON + 7 * DAY, pnl: 7 }),         // lunes siguiente
  ]);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].weekStart, MON + 7 * DAY, 'la semana mas reciente va primero');
  assert.equal(weeks[1].weekStart, MON);
  assert.equal(weeks[1].count, 2);
  assert.equal(weeks[1].totalPnl, 6);
});

test('el review marca lo que falta revisar y destaca los peores', () => {
  const [w] = buildWeeklyReview([
    trade({ pnl: 30, notes: 'plan seguido', setup_tag: 'OB', rule_score: 9 }),
    trade({ pnl: -20, stop_price: 95 }),
    trade({ pnl: -8,  setup_tag: 'FVG', emotion: 'fomo' }),
  ]);
  assert.equal(w.untagged, 1,   'el trade sin setup ni estrategia cuenta como sin etiquetar');
  assert.equal(w.unreviewed, 2, 'dos trades no tienen notas');
  assert.equal(w.avgRuleScore, 9);
  assert.deepEqual(w.emotions, { fomo: 1 });
  assert.equal(w.worst[0].pnl, -20, 'el peor va primero');
  assert.equal(w.worst[0].r, -4);
  assert.equal(w.best[0].pnl, 30);
  assert.ok(Math.abs(w.totalFees - 0.3) < 1e-9);
});

test('el review ignora trades abiertos y sin pnl', () => {
  const weeks = buildWeeklyReview([
    trade({ status: 'open', pnl: null }),
    trade({ pnl: 5 }),
  ]);
  assert.equal(weeks[0].count, 1);
});
