// Los candidatos que ve el admin en el panel de revision.
//
// Desde que solo el Order ID confirma una factura sola, la mayoria de los avisos
// de "ya pagué" caen a revision manual. Esto es lo que evita tener que ir a buscar
// cada pago a mano en Binance: por cada factura, los cobros entrantes que podrian
// ser el suyo. Es una AYUDA para decidir, nunca una confirmacion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, MAX_CANDIDATES } from '../api/_lib/pay-poll.js';

const tx = (o) => ({
  orderId: o.orderId || null,
  transactionId: o.txId,
  amount: o.amount,
  currency: o.currency || 'USDT',
  transactionTime: o.at,
  payerInfo: o.payer ? { name: o.payer } : {},
});

const FACTURA = { id: 'man7_1', amount: '70', currency: 'USDT', binance_nick: 'DynaMalz' };
const T0 = Date.parse('2026-09-10T12:00:00Z');

test('solo entran cobros del mismo monto y la misma moneda', () => {
  const c = buildCandidates([
    tx({ txId: 'a', amount: '70',  at: T0 }),
    tx({ txId: 'b', amount: '70.5', at: T0 }),
    tx({ txId: 'c', amount: '700', at: T0 }),
    tx({ txId: 'd', amount: '70',  currency: 'USDC', at: T0 }),
  ], FACTURA);
  assert.deepEqual(c.map(x => x.txId), ['a']);
});

test('tolera el redondeo de Binance en el monto', () => {
  const c = buildCandidates([
    tx({ txId: 'a', amount: '70.00', at: T0 }),
    tx({ txId: 'b', amount: '69.995', at: T0 }),
    tx({ txId: 'c', amount: '69.9', at: T0 }),
  ], FACTURA);
  assert.deepEqual(c.map(x => x.txId).sort(), ['a', 'b']);
});

test('una transaccion ya usada por otra factura no se ofrece', () => {
  const c = buildCandidates(
    [tx({ txId: 'usada', amount: '70', at: T0 }), tx({ txId: 'libre', amount: '70', at: T0 })],
    FACTURA, new Set(['usada']));
  assert.deepEqual(c.map(x => x.txId), ['libre']);
});

test('el que coincide en nombre va primero, pero no es el unico', () => {
  const c = buildCandidates([
    tx({ txId: 'otro',  amount: '70', at: T0, payer: 'MariaGonzalez' }),
    tx({ txId: 'suyo',  amount: '70', at: T0 - 9e5, payer: 'DynaMalz' }),
  ], FACTURA);
  assert.deepEqual(c.map(x => x.txId), ['suyo', 'otro'], 'el del nombre va arriba aunque sea mas viejo');
  assert.equal(c[0].nameMatch, true);
  assert.equal(c[1].nameMatch, false, 'el otro se ofrece igual: el nombre no decide');
});

test('sin coincidencia de nombre, manda el mas reciente', () => {
  const c = buildCandidates([
    tx({ txId: 'viejo',  amount: '70', at: T0 - 36e5 }),
    tx({ txId: 'nuevo',  amount: '70', at: T0 }),
    tx({ txId: 'medio',  amount: '70', at: T0 - 18e5 }),
  ], FACTURA);
  assert.deepEqual(c.map(x => x.txId), ['nuevo', 'medio', 'viejo']);
});

test('una factura sin referencia declarada igual recibe candidatos, sin marcar ninguno', () => {
  const sinRef = { ...FACTURA, binance_nick: null };
  const c = buildCandidates([tx({ txId: 'a', amount: '70', at: T0, payer: 'DynaMalz' })], sinRef);
  assert.equal(c.length, 1);
  assert.equal(c[0].nameMatch, false);
});

test('el nombre solo marca si es exacto: un prefijo ya no se destaca', () => {
  const c = buildCandidates([
    tx({ txId: 'prefijo', amount: '70', at: T0, payer: 'DynaMalzon' }),
    tx({ txId: 'exacto',  amount: '70', at: T0 - 9e5, payer: 'DynaMalz' }),
  ], FACTURA);
  assert.equal(c.find(x => x.txId === 'prefijo').nameMatch, false);
  assert.equal(c.find(x => x.txId === 'exacto').nameMatch, true);
});

test('la lista esta acotada: el panel no se llena de ruido', () => {
  const muchos = Array.from({ length: 12 }, (_, i) => tx({ txId: 't' + i, amount: '70', at: T0 - i * 6e4 }));
  assert.equal(buildCandidates(muchos, FACTURA).length, MAX_CANDIDATES);
});

test('cada candidato trae lo necesario para cotejarlo en Binance', () => {
  const [c] = buildCandidates(
    [tx({ txId: 'P_A23YT42NEJD71118', orderId: '450541395316375552', amount: '70', at: T0, payer: 'DynaMalz' })],
    FACTURA);
  assert.equal(c.orderId, '450541395316375552');
  assert.equal(c.txId, 'P_A23YT42NEJD71118');
  assert.equal(c.payer, 'DynaMalz');
  assert.equal(c.when, '2026-09-10T12:00:00.000Z');
  assert.equal(c.amount, '70');
});

test('sin cobros que cuadren, no se inventa ninguno', () => {
  assert.deepEqual(buildCandidates([], FACTURA), []);
  assert.deepEqual(buildCandidates([tx({ txId: 'a', amount: '5', at: T0 })], FACTURA), []);
});
