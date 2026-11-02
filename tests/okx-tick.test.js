import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.CRED_ENC_KEY = crypto.randomBytes(32).toString('hex');
const { encrypt } = await import('../api/_lib/crypto.js');
const { tickOkx } = await import('../api/bot-tick.js');

function creds() {
  const k = encrypt('k'), s = encrypt('s'), p = encrypt('p');
  return { enc_key: k.ct, iv_key: k.iv, tag_key: k.tag, enc_secret: s.ct, iv_secret: s.iv, tag_secret: s.tag, enc_pass: p.ct, iv_pass: p.iv, tag_pass: p.tag };
}
const ad = (adId, price, extra) => ({ adId, unitPrice: String(price), minOrderSize: '50000', maxOrderSize: '2000000', availableAmount: '500',
  paymentMethods: ['pagoMovil'], fiatCurrency: 'VES', isOwner: 'false', creator: { nickName: 'n' + adId, type: 'common' }, ...extra });

function mockOkx(mine, buyers, pending = []) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const ok = data => ({ ok: true, status: 200, json: async () => ({ code: '0', msg: '', data }) });
    if (u.pathname.endsWith('/ad/active-list')) return ok(mine);
    if (u.pathname.endsWith('/ad/marketplace-list')) return ok([{ buyAds: buyers, sellAds: [] }]);
    if (u.pathname.endsWith('/order/pending-order')) return ok(pending);
    if (u.pathname.endsWith('/ad/update')) return ok([{ oldAdId: 'old', newAdId: 'NEW1' }]);
    if (u.pathname.endsWith('/ad/update-active-status')) return ok([{ adId: 'NEW1' }]);
    throw new Error('ruta inesperada ' + u.pathname);
  };
  return calls;
}
const cfg = { sellPrice: 1030, minSpread: 1, commission: 0.2, increment: 0.001, maxGap: 1, fiat: 'VES' };
const lo = { minOrderSize: '40000' };
const book = [ad('a', 1001, lo), ad('b', 1000.36, lo), ad('mine2', 748, { ...lo, isOwner: 'true' })];

test('okx tick: primer ciclo salta al mercado, publica el anuncio oculto y sigue el id nuevo', async () => {
  const calls = mockOkx([ad('old', 37.671, { isHidden: true })], book);
  const out = await tickOkx({ user_id: 1, ad_id: 'old', last_tick: null, log: [], config: cfg, ...creds() });
  const up = calls.find(c => c.path.endsWith('/ad/update'));
  assert.equal(up.body.unitPrice, '1001.001');
  assert.equal(up.body.type, 'limit');
  const show = calls.find(c => c.path.endsWith('/update-active-status'));
  assert.deepEqual(show.body, { adId: 'NEW1', status: 'show' });
  assert.equal(out.adId, 'NEW1');
  assert.equal(out.currentPrice, 1001.001);
  assert.equal(out.enabled, true);
  assert.equal(out.book.buyers[0].price, 1001);
});

test('okx tick: despues del arranque respeta el gap y no toca con orden abierta', async () => {
  let calls = mockOkx([ad('x', 990)], book);
  let out = await tickOkx({ user_id: 1, ad_id: 'x', last_tick: new Date().toISOString(), log: [], config: cfg, ...creds() });
  assert.match(out.status, /En espera \(gap/);
  assert.ok(!calls.some(c => c.path.endsWith('/ad/update')));
  calls = mockOkx([ad('x', 1000.5)], book, [{ orderId: 'o1' }]);
  out = await tickOkx({ user_id: 1, ad_id: 'x', last_tick: new Date().toISOString(), log: [], config: cfg, ...creds() });
  assert.equal(out.status, 'En espera: orden abierta');
  assert.ok(!calls.some(c => c.path.endsWith('/ad/update')));
});

test('okx tick: anuncio oculto despues del arranque detiene el bot', async () => {
  mockOkx([ad('x', 1001.001, { isHidden: 'true' })], book);
  const out = await tickOkx({ user_id: 1, ad_id: 'x', last_tick: new Date().toISOString(), log: [], config: cfg, ...creds() });
  assert.equal(out.enabled, false);
});

test('okx tick: el techo ignora la comision de Binance (OKX P2P sin fee)', async () => {
  // techo con fee 0.2%: 1011*0.99*0.998 = 998.9; sin fee: 1000.89 → debe pasar a b (1000.36)
  const calls = mockOkx([ad('x', 999)], [ad('b', 1000.36, lo)]);
  const out = await tickOkx({ user_id: 1, ad_id: 'x', last_tick: new Date().toISOString(), log: [], config: { ...cfg, sellPrice: 1011, maxGap: 2 }, ...creds() });
  assert.equal(calls.find(c => c.path.endsWith('/ad/update')).body.unitPrice, '1000.361');
  assert.equal(out.currentPrice, 1000.361);
});
