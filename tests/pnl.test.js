// Tests del emparejador FIFO de ganancia realizada. Corre con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fifoMatch, summarize, lotsSince } from '../api/_lib/pnl.js';

const T0 = Date.parse('2026-08-20T10:00:00Z');
const min = 60 * 1000;

const buy = (amount, price, tMin = 0) => ({ trade_type: 'BUY', amount, price, created_at: new Date(T0 + tMin * min).toISOString() });
const sell = (amount, price, tMin = 0) => ({ trade_type: 'SELL', amount, price, created_at: new Date(T0 + tMin * min).toISOString() });

test('compra y venta simple → ganancia en USDT al precio de venta', () => {
  // 1000 USDT a 910, vendidos a 920: 10.000 Bs → 10.000/920 = 10.8696 USDT
  const { lots } = fifoMatch([buy(1000, 910), sell(1000, 920, 30)], 0);
  assert.equal(lots.length, 1);
  assert.ok(Math.abs(lots[0].netUsdt - 10000 / 920) < 1e-6);
  assert.equal(lots[0].holdSec, 1800);
});

test('la comision solo descuenta sobre la cantidad comprada', () => {
  const { lots } = fifoMatch([buy(1000, 910), sell(1000, 920)], 0.175);
  assert.ok(Math.abs(lots[0].feeUsdt - 1.75) < 1e-9);
  assert.ok(Math.abs(lots[0].netUsdt - (10000 / 920 - 1.75)) < 1e-6);
});

test('margen neto comparable con el minSpread del bot', () => {
  // techo del bot: sell * (1 - (minSpread + comm)/100). Con sell 920, spread 0.5, comm 0.175
  // el techo es 920*(1-0.00675) = 913.79 → comprar ahi debe dar margen neto 0.5%.
  const cfg = { sellPrice: 920, minSpread: 0.5, commission: 0.175 };
  const ceiling = cfg.sellPrice * (1 - (cfg.minSpread + cfg.commission) / 100);
  const { lots } = fifoMatch([buy(1000, ceiling), sell(1000, cfg.sellPrice)], cfg.commission);
  assert.ok(Math.abs(lots[0].marginPct - 0.5) < 1e-9);
});

test('una venta consume varias compras (FIFO, la mas vieja primero)', () => {
  const { lots, openQty } = fifoMatch([buy(600, 900), buy(600, 910, 5), sell(1000, 920, 10)], 0);
  assert.equal(lots.length, 2);
  assert.equal(lots[0].qty, 600);
  assert.equal(lots[0].buyPrice, 900);
  assert.equal(lots[1].qty, 400);
  assert.equal(lots[1].buyPrice, 910);
  assert.ok(Math.abs(openQty - 200) < 1e-9); // quedan 200 del segundo lote
});

test('venta parcial deja el resto como inventario abierto', () => {
  const { lots, openQty, openAvgPrice } = fifoMatch([buy(1000, 910), sell(300, 920, 5)], 0);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].qty, 300);
  assert.ok(Math.abs(openQty - 700) < 1e-9);
  assert.equal(openAvgPrice, 910);
});

test('venta sin compra previa no inventa ganancia', () => {
  const { lots, unmatchedSell } = fifoMatch([sell(500, 920)], 0);
  assert.equal(lots.length, 0);
  assert.equal(unmatchedSell, 500);
});

test('vender por debajo del costo da perdida', () => {
  const { lots } = fifoMatch([buy(1000, 920), sell(1000, 910, 5)], 0);
  assert.ok(lots[0].netUsdt < 0);
  assert.ok(lots[0].marginPct < 0);
});

test('ignora ordenes sin cantidad o sin precio', () => {
  const { lots, openQty } = fifoMatch([buy(0, 910), buy(100, 0), buy(500, 910), sell(500, 920)], 0);
  assert.equal(lots.length, 1);
  assert.equal(openQty, 0);
});

test('summarize pondera el margen por cantidad', () => {
  // 900 USDT al 1% y 100 al 0% → promedio ponderado 0.9%, no 0.5%
  const lots = [
    { qty: 900, marginPct: 1, grossUsdt: 9, feeUsdt: 0, netUsdt: 9, grossVes: 0, holdSec: 60 },
    { qty: 100, marginPct: 0, grossUsdt: 0, feeUsdt: 0, netUsdt: 0, grossVes: 0, holdSec: 180 },
  ];
  const s = summarize(lots);
  assert.ok(Math.abs(s.marginPct - 0.9) < 1e-9);
  assert.equal(s.qty, 1000);
  assert.equal(s.netUsdt, 9);
  assert.equal(s.medHoldSec, 120);
});

test('summarize sin lotes no rompe', () => {
  const s = summarize([]);
  assert.equal(s.lots, 0);
  assert.equal(s.netUsdt, 0);
  assert.equal(s.marginPct, null);
});

test('lotsSince corta por fecha de venta, no de compra', () => {
  // comprado ayer, vendido hoy → cuenta hoy
  const { lots } = fifoMatch([buy(1000, 910, -600), sell(1000, 920, 5)], 0);
  assert.equal(lotsSince(lots, T0).length, 1);
  assert.equal(lotsSince(lots, T0 + 60 * min).length, 0);
});
