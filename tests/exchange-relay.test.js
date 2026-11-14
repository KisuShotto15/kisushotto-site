import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/exchange-relay.js';
import { useRelay, xfetch } from '../workers/trade-journal-worker/src/exchanges/common.js';

process.env.JWT_SECRET = 'secreto-compartido-de-prueba';
const realFetch = globalThis.fetch;
const upstream = [];

// El POST al relay se entrega al handler de Vercel; lo que el relay pide afuera se registra
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('/api/exchange-relay')) {
    let status = 200, payload = null;
    const res = { status(s) { status = s; return this; }, json(d) { payload = d; return this; } };
    await handler({ method: 'POST', headers: { 'x-relay-sig': init.headers['X-Relay-Sig'] }, body: JSON.parse(init.body) }, res);
    return new Response(JSON.stringify(payload), { status });
  }
  upstream.push({ url: String(url), headers: init.headers, method: init.method });
  return new Response(JSON.stringify({ ok: String(url) }), { status: 200 });
};

test('el relay acepta la firma del worker, agrupa y reenvia', async () => {
  useRelay('https://x.vercel.app/api/exchange-relay', process.env.JWT_SECRET);
  const [a, b] = await Promise.all([
    xfetch('https://fapi.binance.com/fapi/v1/time', { headers: { 'X-MBX-APIKEY': 'k' } }),
    xfetch('https://api.bitget.com/api/v3/market/tickers?category=SPOT', { method: 'GET' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal((await b.json()).ok, 'https://api.bitget.com/api/v3/market/tickers?category=SPOT');
  assert.equal(upstream.length, 2);
  assert.equal(upstream[0].headers['x-mbx-apikey'], 'k');
});

test('el relay no reenvia a hosts fuera de la lista', async () => {
  const r = await xfetch('https://evil.example.com/');
  assert.equal(r.status, 403);
});

test('el relay rechaza una firma falsa', async () => {
  useRelay('https://x.vercel.app/api/exchange-relay', 'otro-secreto');
  await assert.rejects(xfetch('https://fapi.binance.com/fapi/v1/time'), /relay 401/);
  globalThis.fetch = realFetch;
});
