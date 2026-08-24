// Corre con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentReceivedEmail } from '../api/_lib/binancepay-email.js';

// Fixtures capturados de correos reales de do-not-reply@ses.binance.com.
const RECEIVED_SUBJECT = '[Binance] Payment Receive Successful - 2025-12-13 17:28:34 (UTC)';
const RECEIVED_BODY = '| You received an incoming transfer |\n| Time: From: Amount: |\n\n| 2025-12-13 17:28:33(UTC) Emily_Sanchez16 41.41 USDT |\n\n| View Transaction History |';

const SENT_SUBJECT = '[Binance]Payment Transaction Detail - 2025-12-14 02:55:47 (UTC)';
const SENT_BODY = '| You made the following payment: |\n| Time: Amount: |\n\n| 2025-12-14 02:55:46(UTC) 26.52 USDT |';

test('parsea un pago entrante real', () => {
  const r = parsePaymentReceivedEmail({ subject: RECEIVED_SUBJECT, text: RECEIVED_BODY });
  assert.equal(r.senderNick, 'Emily_Sanchez16');
  assert.equal(r.amount, 41.41);
  assert.equal(r.currency, 'USDT');
  assert.equal(r.atUtc.toISOString(), '2025-12-13T17:28:33.000Z');
});

test('ignora los correos de pago saliente (Transaction Detail)', () => {
  assert.equal(parsePaymentReceivedEmail({ subject: SENT_SUBJECT, text: SENT_BODY }), null);
});

test('montos con muchos decimales', () => {
  const r = parsePaymentReceivedEmail({
    subject: '[Binance] Payment Receive Successful - x',
    text: '| 2025-12-13 00:27:29(UTC) Emily_Sanchez16 0.00001 USDT |',
  });
  assert.equal(r.amount, 0.00001);
});

test('sin match devuelve null', () => {
  assert.equal(parsePaymentReceivedEmail({ subject: 'otro correo', text: 'nada relevante' }), null);
});
