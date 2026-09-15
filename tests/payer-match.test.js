// Que confirma una factura sola, y que no.
//
// Antes bastaba con monto + moneda + un nombre que encajara, aceptando ademas que
// uno fuera PREFIJO del otro con 5 caracteres. En una cuenta de operador de P2P,
// donde entran cobros de USDT todo el dia y los montos de suscripcion son fijos
// (70 y 700), eso significaba que declarar "Carlos" bastaba para quedarse con el
// primer cobro de 70 USDT de cualquier Carlos — incluido el de otro cliente, que
// se quedaba sin suscripcion y con su transaccion ya marcada como usada.
//
// Ahora solo el Order ID confirma. El nombre baja a pista para la revision manual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, payerNames, payerLooksLike, orderMatches, refMatches } from '../api/_lib/payer-match.js';

// Transaccion real: el Order ID que el pagador ve en su pantalla es orderId, no
// transactionId. Son dos identificadores distintos del mismo pago.
const REAL = {
  orderId: '450541395316375552',
  transactionId: 'P_A23YT42NEJD71118',
  amount: '496.94', currency: 'USDT',
  payerInfo: { name: 'DynaMalz', type: 'USER' },
};

// ── Normalizacion ───────────────────────────────────────

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

// ── Order ID: lo unico que confirma ─────────────────────

test('el Order ID que el pagador copia de su pantalla confirma la factura', () => {
  assert.ok(refMatches(REAL, '450541395316375552'));
  assert.ok(refMatches(REAL, ' 450541395316375552 '), 'con espacios de sobra');
});

test('tambien vale el transactionId, por si es lo unico que hay', () => {
  assert.ok(orderMatches(REAL, 'P_A23YT42NEJD71118'));
  assert.ok(orderMatches(REAL, 'pa23yt42nejd71118'), 'normalizado da lo mismo');
});

test('un Order ID de otro pago no confirma', () => {
  assert.equal(refMatches(REAL, '450541395316375553'), false);
});

test('un Order ID parcial no confirma: tiene que ser exacto', () => {
  assert.equal(refMatches(REAL, '4505413953'), false);
  assert.equal(refMatches(REAL, '450541395316375552X'), false);
});

// ── El nombre ya NO confirma ────────────────────────────

test('el nombre del pagador no confirma nada, ni siendo exacto', () => {
  assert.equal(refMatches(REAL, 'DynaMalz'), false);
  assert.equal(refMatches(REAL, 'dynamalz'), false);
});

test('el ataque que esto cierra: un prefijo ya no se lleva el pago ajeno', () => {
  // Declarar "Carlos" y esperar al primer cobro de 70 USDT de cualquier Carlos.
  const pago = { orderId: '999', transactionId: 'P_X', payerInfo: { name: 'CarlosRodriguez' } };
  assert.equal(refMatches(pago, 'Carlos'), false);
  assert.equal(refMatches(pago, 'CarlosR'), false);
});

test('el binanceId tampoco confirma: identifica a la persona, no al pago', () => {
  const t = { payerInfo: { name: 'Melida19', binanceId: '1141195884' } };
  assert.equal(refMatches(t, '1141195884'), false);
});

test('sin referencia no se confirma nada', () => {
  assert.equal(refMatches(REAL, ''), false);
  assert.equal(refMatches(REAL, null), false);
  assert.equal(refMatches(REAL, undefined), false);
});

// ── El nombre como pista para el panel manual ───────────

test('payerLooksLike marca al candidato cuyo nombre coincide exacto', () => {
  assert.ok(payerLooksLike(REAL, 'DynaMalz'));
  assert.ok(payerLooksLike(REAL, 'dynamalz'), 'sin distinguir mayusculas');
  assert.ok(payerLooksLike({ payerInfo: { name: 'Melida19', binanceId: '1141195884' } }, '1141195884'));
});

test('la pista es exacta, no por prefijo: era justo lo que rompia', () => {
  assert.equal(payerLooksLike({ payerInfo: { name: 'Melida19' } }, 'Melida'), false);
  assert.equal(payerLooksLike({ payerInfo: { name: 'Efren M' } }, 'Efrén Mendoza'), false);
  assert.equal(payerLooksLike({ payerInfo: { name: 'Susana' } }, 'Ana Perez'), false);
});

test('la pista no salta con otra persona ni con datos ausentes', () => {
  assert.equal(payerLooksLike({ payerInfo: { name: 'Maria Gonzalez' } }, 'Efren Mendoza'), false);
  assert.equal(payerLooksLike({}, 'DynaMalz'), false);
  assert.equal(payerLooksLike({ payerInfo: {} }, 'DynaMalz'), false);
  assert.equal(payerLooksLike({ payerInfo: { name: 'DynaMalz' } }, 'Dyna'), false, 'menos de 5 caracteres');
});

// Salida real de un cobro que el dueño ENVIA: payerInfo es el propio dueño y solo
// trae binanceId. Nunca debe señalar la factura de otro.
test('una transaccion saliente no se parece a ningun suscriptor', () => {
  const saliente = { payerInfo: { binanceId: '126128801', unmaskData: false } };
  assert.equal(payerLooksLike(saliente, 'DynaMalz'), false);
  assert.equal(refMatches(saliente, 'DynaMalz'), false);
});
