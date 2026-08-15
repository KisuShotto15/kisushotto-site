import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpotTrades } from '../workers/trade-journal-worker/src/ingestion.js';

const order = (id, time, side, qty, price, fee = 0, symbol = 'BTCUSDT') => ({
  orderId: id, createdTime: String(time), side, symbol,
  avgPrice: String(price), cumExecQty: String(qty), cumExecFee: String(fee),
});

const T = 1_700_000_000_000;

test('una compra no genera pnl: todavia no se realizo nada', () => {
  const [buy] = buildSpotTrades([order('1', T, 'Buy', 1, 100)]);
  assert.equal(buy.pnl, null);
  assert.equal(buy.status, 'open');
  assert.equal(buy.side, 'buy');
});

test('la venta gana la diferencia contra el costo, no el importe total', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  1, 100),
    order('2', T + 60_000, 'Sell', 1, 150),
  ]);
  const sell = trades.find(t => t.side === 'sell');
  // El bug viejo habria dicho 150 (precio x cantidad); lo real son 50
  assert.equal(sell.pnl, 50);
  assert.equal(sell.status, 'closed');
});

test('el costo promedio pondera varias compras', () => {
  const trades = buildSpotTrades([
    order('1', T,           'Buy',  1, 100),
    order('2', T + 10_000,  'Buy',  1, 200),   // promedio 150
    order('3', T + 20_000,  'Sell', 2, 180),
  ]);
  assert.equal(trades.find(t => t.side === 'sell').pnl, 60);  // (180-150)*2
});

test('los fees se restan de la ganancia', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  1, 100),
    order('2', T + 60_000, 'Sell', 1, 150, 2),
  ]);
  assert.equal(trades.find(t => t.side === 'sell').pnl, 48);
});

test('una venta a perdida da pnl negativo', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  1, 100),
    order('2', T + 60_000, 'Sell', 1, 80),
  ]);
  assert.equal(trades.find(t => t.side === 'sell').pnl, -20);
});

test('sin compra previa no se inventa pnl', () => {
  // Historial incompleto: la venta no tiene costo base conocido
  const [sell] = buildSpotTrades([order('1', T, 'Sell', 1, 150)]);
  assert.equal(sell.pnl, null, 'mejor null que un numero inventado');
});

test('una venta parcial solo consume parte del inventario', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  2, 100),
    order('2', T + 10_000, 'Sell', 1, 120),
    order('3', T + 20_000, 'Sell', 1, 90),
  ]);
  const sells = trades.filter(t => t.side === 'sell');
  assert.equal(sells[0].pnl, 20);
  assert.equal(sells[1].pnl, -10);
});

test('vender mas de lo comprado solo casa lo que hay', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  1, 100),
    order('2', T + 10_000, 'Sell', 3, 150),
  ]);
  // Solo 1 unidad tiene costo conocido, no se inventan las otras 2
  assert.equal(trades.find(t => t.side === 'sell').pnl, 50);
});

test('cada simbolo lleva su propio inventario', () => {
  const trades = buildSpotTrades([
    order('1', T,          'Buy',  1, 100, 0, 'BTCUSDT'),
    order('2', T + 10_000, 'Buy',  1, 10,  0, 'ETHUSDT'),
    order('3', T + 20_000, 'Sell', 1, 150, 0, 'BTCUSDT'),
    order('4', T + 30_000, 'Sell', 1, 12,  0, 'ETHUSDT'),
  ]);
  const btc = trades.find(t => t.symbol === 'BTCUSDT' && t.side === 'sell');
  const eth = trades.find(t => t.symbol === 'ETHUSDT' && t.side === 'sell');
  assert.equal(btc.pnl, 50);
  assert.equal(eth.pnl, 2);
});

test('las ordenes se procesan por tiempo aunque lleguen desordenadas', () => {
  const trades = buildSpotTrades([
    order('2', T + 60_000, 'Sell', 1, 150),
    order('1', T,          'Buy',  1, 100),
  ]);
  assert.equal(trades.find(t => t.side === 'sell').pnl, 50);
});

test('se ignoran ordenes sin cantidad ejecutada', () => {
  assert.equal(buildSpotTrades([order('1', T, 'Buy', 0, 100)]).length, 0);
});
