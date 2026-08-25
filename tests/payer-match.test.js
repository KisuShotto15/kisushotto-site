import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, payerNames, payerMatches } from '../api/_lib/payer-match.js';

test('norm quita acentos, mayusculas y puntuacion', () => {
  assert.equal(norm('Efrén M.'), 'efrenm');
  assert.equal(norm('  JOSÉ  PÉREZ '), 'joseperez');
  assert.equal(norm(null), '');
});

test('payerNames junta los campos utiles y descarta los cortos', () => {
  const t = { payerInfo: { name: 'Efren M', binanceId: '12345678', email: 'a@b.c', nickName: 'ab' } };
  const names = payerNames(t);
  assert.ok(names.includes('efrenm'));
  assert.ok(names.includes('12345678'));
  assert.ok(!names.includes('ab'), 'menos de 3 caracteres no sirve para identificar');
});

test('matchea el nombre completo contra el abreviado de Binance', () => {
  const t = { payerInfo: { name: 'Efren M' } };
  assert.ok(payerMatches(t, 'Efren'), 'lo escrito es prefijo de lo que muestra Binance');
  assert.ok(payerMatches(t, 'efren m'), 'coincidencia exacta tras normalizar');
});

test('matchea aunque el usuario escriba su nombre completo', () => {
  const t = { payerInfo: { name: 'Efren Mendoza' } };
  assert.ok(payerMatches(t, 'Efrén Mendoza'), 'los acentos no deben romperlo');
});

test('no matchea a otra persona', () => {
  const t = { payerInfo: { name: 'Maria Gonzalez' } };
  assert.equal(payerMatches(t, 'Efren Mendoza'), false);
});

test('matchea por binanceId cuando no viene el nombre', () => {
  const t = { payerInfo: { binanceId: '987654321' } };
  assert.ok(payerMatches(t, '987654321'));
});

test('un nick de menos de 3 caracteres nunca matchea', () => {
  const t = { payerInfo: { name: 'Efren M' } };
  assert.equal(payerMatches(t, 'Ef'), false, 'seria demasiado laxo: matchearia a cualquiera');
});

test('sin payerInfo no matchea nada', () => {
  assert.equal(payerMatches({}, 'Efren'), false);
  assert.equal(payerMatches({ payerInfo: {} }, 'Efren'), false);
});
