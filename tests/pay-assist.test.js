import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPayInfo, holderMatches, fillTpl, queueText, isUnpaidBuy, chatText, chatImage } from '../api/_lib/binance.js';

const det = {
  sellerName: 'PEREZ GOMEZ JOSE LUIS', selectedPayId: null,
  payMethods: [
    { id: 11, identifier: 'PagoMovil', fields: [{ fieldName: 'Teléfono', fieldValue: '04141234567' }] },
    { id: 22, identifier: 'BancoDeVenezuela', tradeMethodName: 'Banco de Venezuela', fields: [
      { fieldName: 'Nombre', fieldContentType: 'payee', fieldValue: 'José Luis Pérez' },
      { fieldName: 'Número de cuenta', fieldContentType: 'pay_account', fieldValue: '0102-0123-45-0001234567' },
      { fieldName: 'Cédula', fieldValue: '' },
    ] },
  ],
};

test('pago: toma el metodo BDV, la cuenta de 20 digitos y el titular', () => {
  const p = pickPayInfo(det);
  assert.equal(p.payId, 22);
  assert.equal(p.account, '01020123450001234567');
  assert.equal(p.holder, 'José Luis Pérez');
  assert.equal(p.fields.length, 2); // el campo vacio no se muestra
  assert.equal(pickPayInfo({ ...det, selectedPayId: 11 }).payId, 11);
  assert.equal(pickPayInfo({ payMethods: [] }), null);
});

test('pago: titular vs nombre verificado (sin acentos, dos palabras en comun)', () => {
  assert.equal(holderMatches('José Luis Pérez', det.sellerName), true);
  assert.equal(holderMatches('Maria Rodriguez', det.sellerName), false);
  assert.equal(holderMatches(null, det.sellerName), null);
});

test('pago: plantillas, cola y ordenes por pagar', () => {
  assert.equal(fillTpl('Hola {nombre}, {cola} {x}', { nombre: 'Ana', cola: queueText(0) }), 'Hola Ana, Eres el siguiente en la cola de pagos. {x}');
  assert.equal(queueText(2), 'Tienes 2 pagos por delante, te pago en breve.');
  assert.equal(queueText(1), 'Tienes 1 pago por delante, te pago en breve.');
  assert.ok(isUnpaidBuy({ tradeType: 'BUY', orderStatus: 'TRADING' }));
  assert.ok(!isUnpaidBuy({ tradeType: 'BUY', orderStatus: 'COMPLETED' }));
  assert.ok(!isUnpaidBuy({ tradeType: 'SELL', orderStatus: 'TRADING' }));
});

test('chat: mensajes con la forma del historial de Binance', () => {
  const t = chatText(123, 'hola');
  assert.equal(t.type, 'text'); assert.equal(t.orderNo, '123'); assert.match(t.uuid, /^msg_\d+_\d+$/);
  const i = chatImage('123', 'https://x/y.jpg', 800, 600);
  assert.equal(i.type, 'image'); assert.match(i.uuid, /^img_/); assert.equal(i.imageUrl, 'https://x/y.jpg'); assert.equal(i.width, 800);
});
