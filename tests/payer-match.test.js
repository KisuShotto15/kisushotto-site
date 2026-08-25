import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, payerNames, payerMatches } from '../api/_lib/payer-match.js';

test('norm quita acentos, mayusculas y puntuacion', () => {
  assert.equal(norm('Efrén M.'), 'efrenm');
  assert.equal(norm('  JOSÉ  PÉREZ '), 'joseperez');
  assert.equal(norm(null), '');
});

// Forma real de payerInfo, tomada del historial de Binance Pay: el name es el
// nickname de la cuenta y el binanceId a veces viene y a veces no.
test('payerNames lee los campos que Binance manda de verdad', () => {
  assert.deepEqual(payerNames({ payerInfo: { name: 'DynaMalz', type: 'USER', unmaskData: false } }), ['dynamalz']);
  const conId = payerNames({ payerInfo: { name: 'Melida19', binanceId: '1141195884' } });
  assert.ok(conId.includes('melida19'));
  assert.ok(conId.includes('1141195884'));
});

test('descarta identificadores demasiado cortos para distinguir a nadie', () => {
  assert.deepEqual(payerNames({ payerInfo: { name: 'Ana' } }), []);
});

test('matchea el nickname exacto', () => {
  assert.ok(payerMatches({ payerInfo: { name: 'DynaMalz' } }, 'DynaMalz'));
  assert.ok(payerMatches({ payerInfo: { name: 'DynaMalz' } }, 'dynamalz'), 'sin distinguir mayusculas');
});

test('matchea el nickname sin el sufijo numerico', () => {
  assert.ok(payerMatches({ payerInfo: { name: 'Melida19' } }, 'Melida'));
});

test('matchea el nombre completo contra el abreviado de Binance', () => {
  assert.ok(payerMatches({ payerInfo: { name: 'Efren M' } }, 'Efrén Mendoza'));
});

test('matchea por binanceId cuando el usuario pone el numero', () => {
  assert.ok(payerMatches({ payerInfo: { name: 'Melida19', binanceId: '1141195884' } }, '1141195884'));
});

test('no matchea a otra persona', () => {
  assert.equal(payerMatches({ payerInfo: { name: 'Maria Gonzalez' } }, 'Efren Mendoza'), false);
});

// El fallo que motivo pasar de "contiene" a "prefijo".
test('un nombre contenido en otro NO matchea', () => {
  assert.equal(payerMatches({ payerInfo: { name: 'Susana' } }, 'Ana Perez'), false);
  assert.equal(payerMatches({ payerInfo: { name: 'Carlos Malzon' } }, 'Malzon'), false,
    'coincidir por el apellido suelto no basta');
});

test('un nick de menos de 5 caracteres nunca matchea', () => {
  assert.equal(payerMatches({ payerInfo: { name: 'DynaMalz' } }, 'Dyna'), false);
});

test('sin payerInfo no matchea nada', () => {
  assert.equal(payerMatches({}, 'DynaMalz'), false);
  assert.equal(payerMatches({ payerInfo: {} }, 'DynaMalz'), false);
});

// Salida real de un cobro que el dueño ENVIA: payerInfo es el propio dueño y solo
// trae binanceId. Nunca debe confirmar la factura de otro.
test('una transaccion saliente no matchea a un suscriptor', () => {
  const saliente = { payerInfo: { binanceId: '126128801', unmaskData: false } };
  assert.equal(payerMatches(saliente, 'DynaMalz'), false);
});

// ── Order ID ────────────────────────────────────────────
// Lo que el usuario copia de Binance Pay al terminar el pago. Identifica UNA
// transaccion, asi que no hay ambiguedad posible.
import { orderMatches, refMatches } from '../api/_lib/payer-match.js';

// Transaccion real: el Order ID que el pagador ve en su pantalla es orderId, no
// transactionId. Son dos identificadores distintos del mismo pago.
const REAL = {
  orderId: '450541395316375552',
  transactionId: 'P_A23YT42NEJD71118',
  amount: '496.94', currency: 'USDT',
  payerInfo: { name: 'DynaMalz', type: 'USER' },
};

test('matchea el Order ID que el pagador copia de su pantalla', () => {
  assert.ok(orderMatches(REAL, '450541395316375552'));
  assert.ok(orderMatches(REAL, ' 450541395316375552 '), 'con espacios de sobra');
});

test('matchea tambien el transactionId, por si es lo unico que hay', () => {
  assert.ok(orderMatches(REAL, 'P_A23YT42NEJD71118'));
  assert.ok(orderMatches(REAL, 'pa23yt42nejd71118'), 'normalizado da lo mismo');
});

test('un Order ID de otro pago no matchea', () => {
  assert.equal(orderMatches(REAL, '450541395316375553'), false);
});

test('un Order ID parcial no matchea: tiene que ser exacto', () => {
  assert.equal(orderMatches(REAL, '4505413953'), false);
});

test('refMatches acepta el Order ID o el usuario, lo que haya dado', () => {
  assert.ok(refMatches(REAL, '450541395316375552'), 'por Order ID');
  assert.ok(refMatches(REAL, 'DynaMalz'), 'por usuario');
  assert.equal(refMatches(REAL, 'OtroUsuario'), false);
});
