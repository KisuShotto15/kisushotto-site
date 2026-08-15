import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBinancePositions } from '../workers/trade-journal-worker/src/ingestion.js';

const fill = (id, time, side, qty, price, realizedPnl = 0, commission = 0) =>
  ({ id, time, side, qty: String(qty), price: String(price), realizedPnl: String(realizedPnl),
     commission: String(commission), symbol: 'BTCUSDT', positionSide: 'BOTH' });

test('un long simple abre y cierra como un solo trade', () => {
  const pos = buildBinancePositions([
    fill(1, 1_700_000_000_000, 'BUY',  1, 100, 0,  0.05),
    fill(2, 1_700_000_600_000, 'SELL', 1, 110, 10, 0.055),
  ]);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].side, 'long');
  assert.equal(pos[0].entry_price, 100);
  assert.equal(pos[0].exit_price, 110);
  assert.equal(pos[0].size, 1);
  assert.equal(pos[0].pnl, 10);
  assert.ok(Math.abs(pos[0].fees - 0.105) < 1e-9);
  assert.equal(pos[0].exit_time, 1_700_000_600);
});

test('la apertura sola no genera trade cerrado', () => {
  assert.equal(buildBinancePositions([fill(1, 1_700_000_000_000, 'BUY', 1, 100)]).length, 0);
});

test('entradas y salidas parciales promedian precio y suman pnl', () => {
  const pos = buildBinancePositions([
    fill(1, 1_700_000_000_000, 'BUY',  1, 100),
    fill(2, 1_700_000_100_000, 'BUY',  1, 120),
    fill(3, 1_700_000_200_000, 'SELL', 1, 130, 20),
    fill(4, 1_700_000_300_000, 'SELL', 1, 140, 30),
  ]);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].entry_price, 110);
  assert.equal(pos[0].exit_price, 135);
  assert.equal(pos[0].size, 2);
  assert.equal(pos[0].pnl, 50);
});

test('un short se detecta por el sentido del primer fill', () => {
  const pos = buildBinancePositions([
    fill(1, 1_700_000_000_000, 'SELL', 2, 100),
    fill(2, 1_700_000_100_000, 'BUY',  2, 90, 20),
  ]);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].side, 'short');
  assert.equal(pos[0].pnl, 20);
});

test('un flip cierra el long y abre el short en el mismo fill', () => {
  const pos = buildBinancePositions([
    fill(1, 1_700_000_000_000, 'BUY',  1, 100),
    fill(2, 1_700_000_100_000, 'SELL', 3, 110, 10),  // cierra 1 long, abre 2 short
    fill(3, 1_700_000_200_000, 'BUY',  2, 105, 10),
  ]);
  assert.equal(pos.length, 2);
  assert.equal(pos[0].side, 'long');
  assert.equal(pos[0].size, 1);
  assert.equal(pos[1].side, 'short');
  assert.equal(pos[1].size, 2);
  assert.equal(pos[1].entry_price, 110);
  assert.equal(pos[1].exit_price, 105);
});

test('simbolos distintos no se mezclan', () => {
  const eth = { ...fill(9, 1_700_000_000_000, 'BUY', 1, 50), symbol: 'ETHUSDT' };
  const pos = buildBinancePositions([
    eth,
    { ...fill(10, 1_700_000_100_000, 'SELL', 1, 60, 10), symbol: 'ETHUSDT' },
    fill(1, 1_700_000_000_000, 'BUY',  1, 100),
    fill(2, 1_700_000_100_000, 'SELL', 1, 110, 10),
  ]);
  assert.equal(pos.length, 2);
  assert.deepEqual([...new Set(pos.map(p => p.symbol))].sort(), ['BTCUSDT', 'ETHUSDT']);
});

test('cada posicion tiene un exchange_id estable y unico', () => {
  const fills = [
    fill(1, 1_700_000_000_000, 'BUY',  1, 100),
    fill(2, 1_700_000_100_000, 'SELL', 1, 110, 10),
    fill(3, 1_700_000_200_000, 'BUY',  1, 100),
    fill(4, 1_700_000_300_000, 'SELL', 1, 105, 5),
  ];
  const a = buildBinancePositions(fills);
  const b = buildBinancePositions(fills);
  assert.deepEqual(a.map(p => p.exchange_id), b.map(p => p.exchange_id));
  assert.equal(new Set(a.map(p => p.exchange_id)).size, 2);
});
