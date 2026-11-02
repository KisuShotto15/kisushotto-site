import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { okxSign, okxRequest, mapOkxAd, splitMarketplace } from '../api/_lib/okx.js';

// Fragmento del "Sample Response" de marketplace-list en la doc de OKX.
const sample = {
  code: 0,
  data: [{
    buyAds: [
      { adId: '230206170034022', availableAmount: '154.00', unitPrice: '6.4600', minOrderSize: '1.00', maxOrderSize: '646.00',
        paymentMethods: ['bank'], side: 'buy', isOwner: 'false',
        creator: { nickName: '1234424', completedOrders: '200001', completionRate: '0.9999', type: 'diamond' } },
      { adId: '230208145147869', availableAmount: '29.00', unitPrice: '6.4700', minOrderSize: '1.00', maxOrderSize: '187.34',
        paymentMethods: ['bank'], side: 'buy', isOwner: 'true',
        creator: { nickName: 'Test', completedOrders: '0', completionRate: '0.0000', type: 'certified' } },
    ],
    sellAds: [
      { adId: 's2', availableAmount: '10', unitPrice: '6.60', minOrderSize: '1', maxOrderSize: '50', creator: { nickName: 'B', type: 'common' } },
      { adId: 's1', availableAmount: '10', unitPrice: '6.55', minOrderSize: '1', maxOrderSize: '50', creator: { nickName: 'A', type: 'common' } },
      { adId: 's0', availableAmount: '0', unitPrice: '6.50', creator: { nickName: 'vacio' } },
    ],
  }],
};

test('okxSign: HMAC-SHA256 base64 de timestamp + metodo + ruta + cuerpo', () => {
  const ts = '2026-11-02T14:21:00.000Z';
  const exp = crypto.createHmac('sha256', 's3cr3t').update(ts + 'GET' + '/api/v5/p2p/ad?adId=1').digest('base64');
  assert.equal(okxSign('s3cr3t', ts, 'GET', '/api/v5/p2p/ad?adId=1', ''), exp);
});

test('okxRequest: GET firma la ruta con query; POST firma el cuerpo; code 0 numerico o "0" es ok', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => (calls.length === 1 ? { code: 0, data: [1] } : { code: '0', data: [] }) }; };
  try {
    const creds = { key: 'K', secret: 'S', passphrase: 'P' };
    const g = await okxRequest(creds, 'GET', '/api/v5/p2p/ad/active-list', { side: 'buy', fiatCurrency: 'VES', vacio: '' });
    const p = await okxRequest(creds, 'POST', '/api/v5/p2p/ad/update', { adId: '9', unitPrice: '990.5' });
    assert.equal(g.ok, true); assert.equal(p.ok, true);
    const [c1, c2] = calls;
    assert.equal(c1.url, 'https://www.okx.com/api/v5/p2p/ad/active-list?side=buy&fiatCurrency=VES');
    const h1 = c1.opts.headers;
    assert.equal(h1['OK-ACCESS-KEY'], 'K'); assert.equal(h1['OK-ACCESS-PASSPHRASE'], 'P');
    assert.equal(h1['OK-ACCESS-SIGN'], okxSign('S', h1['OK-ACCESS-TIMESTAMP'], 'GET', '/api/v5/p2p/ad/active-list?side=buy&fiatCurrency=VES', ''));
    assert.equal(c1.opts.body, undefined);
    const h2 = c2.opts.headers;
    assert.equal(c2.opts.body, JSON.stringify({ adId: '9', unitPrice: '990.5' }));
    assert.equal(h2['OK-ACCESS-SIGN'], okxSign('S', h2['OK-ACCESS-TIMESTAMP'], 'POST', '/api/v5/p2p/ad/update', c2.opts.body));
  } finally { globalThis.fetch = orig; }
});

test('okxRequest: un code distinto de 0 no es ok y trae el mensaje', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: '50113', msg: 'Invalid Sign' }) });
  try {
    const r = await okxRequest({ key: 'K', secret: 'S', passphrase: 'P' }, 'GET', '/api/v5/p2p/user/basic-info');
    assert.equal(r.ok, false); assert.equal(r.code, '50113'); assert.equal(r.msg, 'Invalid Sign');
  } finally { globalThis.fetch = orig; }
});

test('mapOkxAd: mismo formato que el monitor; isOwner "false" (texto) NO es propio', () => {
  const a = mapOkxAd(sample.data[0].buyAds[0]);
  assert.deepEqual(a, { advNo: '230206170034022', price: 6.46, minVES: 1, maxVES: 646, avail: 154, merchant: '1234424',
    orders: 200001, comp: 100, payTypes: ['bank'], badges: ['diamond'], vipLevel: 3, isOwner: false });
  assert.equal(mapOkxAd(sample.data[0].buyAds[1]).isOwner, true);
  assert.equal(mapOkxAd(sample.data[0].sellAds[0]).badges, null); // common = sin insignia
});

test('splitMarketplace: compradores de mayor a menor, vendedores de menor a mayor, sin vacios', () => {
  const { buyers, sellers } = splitMarketplace(sample.data);
  assert.deepEqual(buyers.map(x => x.price), [6.47, 6.46]);
  assert.deepEqual(sellers.map(x => x.advNo), ['s1', 's2']);
  assert.deepEqual(splitMarketplace(null), { buyers: [], sellers: [] });
});

test('okx: reprice de compra con el libro de OKX (adaptador + computeReprice)', async () => {
  const { okxAdForReprice, okxRawForReprice, okxRoundPrice } = await import('../api/_lib/okx.js');
  const { computeReprice } = await import('../api/_lib/reprice.js');
  const mk = (adId, price, extra) => ({ adId, unitPrice: String(price), minOrderSize: '50000', maxOrderSize: '2000000',
    availableAmount: '500', paymentMethods: ['pagoMovil'], isOwner: 'false', creator: { nickName: 'n' + adId, type: 'common' }, ...extra });
  const mine = mk('me', 995, { fiatCurrency: 'ves' });
  const lo = { minOrderSize: '40000' };
  const book = [mk('a', 1001.5, lo), mk('b', 999, lo), mk('c', 1003, { ...lo, paymentMethods: ['zelle'] })];
  const res = computeReprice({ ad: okxAdForReprice(mine), marketRaw: book.map(okxRawForReprice),
    cfg: { sellPrice: 1020, minSpread: 1, commission: 0, increment: 0.01, maxGap: 10, verifiedOnly: false } });
  // c no comparte metodo de pago; sube sobre a (1001.5 + 0.01)
  assert.ok(Math.abs(res.targetPrice - 1001.51) < 1e-9, String(res.targetPrice));
  assert.equal(okxRoundPrice(1001.5149, 0.01, res.ceiling), 1001.51);
  // nunca sobre el techo
  assert.equal(okxRoundPrice(1009.796, 0.01, 1009.79), 1009.79);
  assert.equal(okxRoundPrice(1009.7951, 0.01, 1009.792), 1009.79);
});
