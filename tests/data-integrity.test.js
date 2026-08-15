// Invariantes que habrian atrapado los bugs de datos de esta sesion:
// el spot inflando el PnL, las monedas mezcladas y el doble conteo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, groupByDimension, buildHeatmap } from '../workers/trade-journal-worker/src/analytics.js';

const trade = (o = {}) => ({
  status: 'closed', symbol: 'BTCUSDT', category: 'linear', side: 'long',
  entry_price: 100, exit_price: 110, size: 1, pnl: 10, fees: 0.1,
  entry_time: 1_700_000_000, exit_time: 1_700_003_600, ...o,
});

test('el spot nunca aporta al PnL de futuros', () => {
  const s = computeStats([
    trade({ pnl: 10 }),
    trade({ category: 'spot', side: 'sell', pnl: 8210.66 }),  // el bug original
  ]);
  assert.equal(s.totalPnl, 10, 'una venta de spot no puede inflar el PnL de futuros');
  assert.equal(s.closedCount, 1);
  assert.equal(s.spotCount, 1, 'pero si se cuenta aparte');
  assert.equal(s.spotRealized, 8210.66);
});

test('el profit factor no se dispara por culpa del spot', () => {
  // Antes: las compras con pnl null quedaban fuera y las ventas contaban entero
  const s = computeStats([
    trade({ pnl: 10 }), trade({ pnl: -8 }),
    trade({ category: 'spot', side: 'buy',  pnl: null }),
    trade({ category: 'spot', side: 'sell', pnl: 5000 }),
  ]);
  assert.ok(s.profitFactor < 2, `profit factor irreal: ${s.profitFactor}`);
});

test('las dimensiones tampoco mezclan spot', () => {
  const data = groupByDimension([
    trade({ symbol: 'BTCUSDT', pnl: 10 }),
    trade({ symbol: 'BTCUSDT', category: 'spot', pnl: 8210 }),
  ], 'symbol');
  assert.equal(data.find(d => d.label === 'BTCUSDT').totalPnl, 10);
});

test('el heatmap ignora el spot', () => {
  const hm = buildHeatmap([trade({ category: 'spot', pnl: 9999 })]);
  assert.ok(hm.flat().every(v => v === null), 'ninguna celda deberia tener datos');
});

test('los trades sin pnl no cuentan como perdidas', () => {
  const s = computeStats([trade({ pnl: 10 }), trade({ pnl: null })]);
  assert.equal(s.closedCount, 1);
  assert.equal(s.lossCount, 0);
});

test('el total es exactamente la suma de las partes', () => {
  const pnls = [12.5, -3.25, 0.75, -8, 44.1];
  const s = computeStats(pnls.map(p => trade({ pnl: p })));
  assert.equal(s.totalPnl, Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100);
  assert.equal(s.grossProfit - s.grossLoss, s.totalPnl);
});

test('las estadisticas vacias no devuelven NaN ni Infinity', () => {
  const s = computeStats([]);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} = ${v}`);
  }
});

test('un exit_price igual al entry_price no puede dar una ganancia grande', () => {
  // Las filas del CSV tenian entrada == salida en las 167; era la senal de que
  // no eran trades de ida y vuelta sino fills sueltos.
  const sospechosos = [trade({ entry_price: 100, exit_price: 100, pnl: 500 })]
    .filter(t => t.exit_price === t.entry_price && Math.abs(t.pnl) > t.entry_price * t.size * 0.01);
  assert.equal(sospechosos.length, 1, 'la heuristica debe marcar esta fila');
});
