import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getOrderDetail, chatMessages } from '../api/_lib/binance.js';

function mock(resp) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => resp }; };
  return calls;
}
const sigOk = (url, secret) => {
  const [, qs] = url.split('?'); const i = qs.lastIndexOf('&signature=');
  return crypto.createHmac('sha256', secret).update(qs.slice(0, i)).digest('hex') === qs.slice(i + 11);
};

test('c2c: detalle de orden firma la query y manda adOrderNo en el body', async () => {
  const calls = mock({ code: '000000', success: true, data: { orderNumber: '1' } });
  const r = await getOrderDetail('k', 's', '123');
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /\/sapi\/v1\/c2c\/orderMatch\/getUserOrderDetail\?recvWindow=10000&timestamp=\d+&signature=/);
  assert.ok(sigOk(calls[0].url, 's'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { adOrderNo: '123' });
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], 'k');
});

test('c2c: GET con params en la query firmada y error de Binance = no ok', async () => {
  const calls = mock({ code: '-1002', message: 'no autorizado', success: false });
  const r = await chatMessages('k', 's', '999', 5);
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'no autorizado');
  assert.match(calls[0].url, /orderNo=999&page=1&rows=5&recvWindow=10000&timestamp=/);
  assert.ok(sigOk(calls[0].url, 's'));
  assert.equal(calls[0].init.body, undefined);
});
