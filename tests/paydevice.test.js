import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, confirmProblem } from '../api/_lib/paydevice.js';

const info = { amount: 370000, account: '01020123450001236058', sellerName: 'MENDOZA DIAZ EFREN ALEJANDRO' };

test('telefono: montos en centimos desde BDV y desde la orden', () => {
  assert.equal(cents('370.000,00 Bs'), 37000000);
  assert.equal(cents(370000), 37000000);
  assert.equal(cents('0,02 Bs'), 2);
  assert.equal(cents(1234.5), 123450);
});

test('telefono: confirmacion de BDV contra la orden', () => {
  const ok = { amount: '370.000,00 Bs', dest: '0102****6058', name: 'Efren Alejandro Mendoza Diaz' };
  assert.equal(confirmProblem(info, ok), null);
  assert.match(confirmProblem(info, { ...ok, amount: '370.000,01 Bs' }), /monto/);
  assert.match(confirmProblem(info, { ...ok, dest: '0102****6059' }), /cuenta destino/);
  assert.match(confirmProblem(info, { ...ok, dest: '' }), /cuenta destino/);
  assert.match(confirmProblem(info, { ...ok, name: 'Maria Perez' }), /titular/);
  assert.match(confirmProblem(info, { ...ok, name: '' }), /titular/); // sin nombre no se confirma solo
});
