import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEquityCurve, computeStats } from '../workers/trade-journal-worker/src/analytics.js';

const t = (pnl, i = 0) => ({
  status: 'closed', category: 'linear', symbol: 'BTCUSDT', side: 'long',
  entry_price: 100, exit_price: 110, size: 1, pnl, fees: 0,
  entry_time: 1_700_000_000 + i * 3600, exit_time: 1_700_001_000 + i * 3600,
});

test('el drawdown en % nunca puede pasar de 100', () => {
  // El caso que rompia: ganar 10 y perder 12 daba 120% contra el pico del PnL
  const { maxDD } = buildEquityCurve([t(10, 0), t(-12, 1)], 1000);
  assert.ok(maxDD <= 100, `drawdown imposible: ${maxDD}%`);
});

test('se mide contra el capital, no contra el pico del PnL', () => {
  // Capital actual 1000 con PnL total -8 => se partio de 1008
  const { maxDD, maxDDAbs } = buildEquityCurve([t(20, 0), t(-28, 1)], 1000);
  assert.equal(maxDDAbs, 28, 'la caida desde el pico son 28 USDT');
  // 28 sobre un pico de 1028 es ~2.7%, no 140%
  assert.ok(maxDD > 2 && maxDD < 3, `esperaba ~2.7%, salio ${maxDD}%`);
});

test('sin capital conocido no se inventa un porcentaje', () => {
  const { maxDD, maxDDAbs } = buildEquityCurve([t(10, 0), t(-12, 1)]);
  assert.equal(maxDD, null, 'mejor null que un porcentaje sin base');
  assert.equal(maxDDAbs, 12);
});

test('la caida absoluta se mide de pico a valle, no del inicio', () => {
  // Sube a 50, baja a 10 (caida de 40), vuelve a subir
  const { maxDDAbs } = buildEquityCurve([t(50, 0), t(-40, 1), t(30, 2)]);
  assert.equal(maxDDAbs, 40);
});

test('una curva que solo sube no tiene drawdown', () => {
  const { maxDD, maxDDAbs } = buildEquityCurve([t(10, 0), t(5, 1), t(20, 2)], 1000);
  assert.equal(maxDDAbs, 0);
  assert.equal(maxDD, 0);
});

test('un capital incoherente se ignora en vez de dar negativos', () => {
  // equity actual menor que el PnL total: la resta daria capital inicial <= 0
  const { maxDD } = buildEquityCurve([t(500, 0), t(-100, 1)], 10);
  assert.equal(maxDD, null);
});

test('computeStats expone la base usada para el drawdown', () => {
  const conCapital = computeStats([t(10, 0), t(-12, 1)], { equityNow: 1000 });
  assert.equal(conCapital.drawdownBase, 'capital');
  assert.ok(conCapital.maxDrawdown <= 100);

  const sinCapital = computeStats([t(10, 0), t(-12, 1)]);
  assert.equal(sinCapital.drawdownBase, 'pico');
  assert.equal(sinCapital.maxDrawdown, null);
  assert.equal(sinCapital.maxDrawdownAbs, 12, 'el absoluto sigue estando');
});
