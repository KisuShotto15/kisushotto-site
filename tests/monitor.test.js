// Tests de monitor.js (alertas, series de precio, mediana). Corre con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pushHist24, pushHistLong, histMap, pushHist24Pay, pushOhlcPay,
  histPaySnapshot, histPayChanged, topMedianRate, computeAlerts,
} from '../api/_lib/monitor.js';

const MIN = 60000;

function rawAd({ price, avail = 5000, merchant = 'v1', badges = ['verified'] } = {}) {
  return {
    adv: { price: String(price), tradableQuantity: String(avail) },
    advertiser: { nickName: merchant, badges },
  };
}

// ── Series ────────────────────────────────────────────

test('pushHist24: agrega solo cada ~4.5 min y recorta >25h', () => {
  const t0 = 1000000000000;
  let h = pushHist24([], t0, 100);
  h = pushHist24(h, t0 + 2 * MIN, 101);      // muy pronto: no agrega
  assert.equal(h.length, 1);
  h = pushHist24(h, t0 + 5 * MIN, 102);      // pasa el umbral
  assert.equal(h.length, 2);
  h = pushHist24(h, t0 + 26 * 3600000, 103); // todo lo previo queda fuera de 25h
  assert.deepEqual(h.map(p => p.price), [103]);
});

test('pushHistLong: espaciado 30 min, sin recorte', () => {
  const t0 = 1000000000000;
  let h = pushHistLong([], t0, 100);
  h = pushHistLong(h, t0 + 29 * MIN, 101);
  assert.equal(h.length, 1);
  h = pushHistLong(h, t0 + 30 * MIN, 102);
  assert.equal(h.length, 2);
});

test('precio falsy no agrega punto', () => {
  assert.equal(pushHist24([{ ts: 1, price: 9 }], 2, 0).length, 1);
  assert.equal(pushHistLong([], 2, null).length, 0);
});

test('histMap: array legado se mapea a BancoDeVenezuela', () => {
  const legacy = [{ ts: 1, price: 100 }];
  assert.deepEqual(histMap(legacy), { BancoDeVenezuela: legacy });
  assert.deepEqual(histMap(null), {});
});

test('pushHist24Pay mantiene series separadas por metodo', () => {
  const t0 = 1000000000000;
  let m = pushHist24Pay({}, 'BDV', t0, 100);
  m = pushHist24Pay(m, 'Zinli', t0, 200);
  assert.equal(m.BDV[0].price, 100);
  assert.equal(m.Zinli[0].price, 200);
});

test('pushOhlcPay: misma hora actualiza h/l/c, hora nueva abre vela', () => {
  const t0 = Math.floor(1000000000000 / 3600000) * 3600000; // borde de hora
  let m = pushOhlcPay({}, 'BDV', t0 + 1000, 100);
  m = pushOhlcPay(m, 'BDV', t0 + 2000, 105);
  m = pushOhlcPay(m, 'BDV', t0 + 3000, 98);
  assert.equal(m.BDV.length, 1);
  assert.deepEqual(m.BDV[0], { t: t0, o: 100, h: 105, l: 98, c: 98 });
  m = pushOhlcPay(m, 'BDV', t0 + 3600000 + 1000, 99);
  assert.equal(m.BDV.length, 2);
  assert.equal(m.BDV[1].o, 99);
});

test('histPaySnapshot/Changed detecta cambios reales', () => {
  const t0 = 1000000000000;
  const before = { BDV: [{ ts: t0, price: 100 }] };
  const snap = histPaySnapshot(before, 'BDV');
  const same = pushHist24Pay(before, 'BDV', t0 + MIN, 101); // no agrega (muy pronto)
  assert.equal(histPayChanged(snap, same, 'BDV'), false);
  const changed = pushHist24Pay(before, 'BDV', t0 + 5 * MIN, 101);
  assert.equal(histPayChanged(snap, changed, 'BDV'), true);
});

// ── Mediana ───────────────────────────────────────────

test('topMedianRate: mediana impar y par, filtra avail<2000 y sin badge', () => {
  const raw = [
    rawAd({ price: 100 }), rawAd({ price: 102 }), rawAd({ price: 104 }),
    rawAd({ price: 999, avail: 100 }),      // fantasma: fuera
    rawAd({ price: 998, badges: [] }),      // sin badge: fuera
  ];
  assert.deepEqual(topMedianRate(raw, 3, true), { rate: 102, n: 3 });
  assert.equal(topMedianRate(raw, 2, true).rate, 103); // (102+104)/2 — toma los 2 mas altos
  assert.equal(topMedianRate([], 3, true), null);
});

// ── Alertas ───────────────────────────────────────────

const cfgAlert = { spreadThr: 0.5, overboughtThr: 1.0, weaknessThr: 0.5, commission: 0 };

test('spread sobre umbral dispara alerta y respeta cooldown', () => {
  const mayRaw = [rawAd({ price: 110, merchant: 'mayor' })];
  const smallRaw = [rawAd({ price: 108 })]; // spread ~1.8%
  const now = 1000000000000;
  const r1 = computeAlerts({ mayRaw, smallRaw, cfg: cfgAlert, priceHist: [], cooldowns: {}, now });
  assert.equal(r1.alerts.length, 1);
  assert.equal(r1.alerts[0].type, 'spread');
  // 2 min despues: en cooldown (5 min) → no repite
  const r2 = computeAlerts({ mayRaw, smallRaw, cfg: cfgAlert, priceHist: r1.priceHist, cooldowns: r1.cooldowns, now: now + 2 * MIN });
  assert.equal(r2.alerts.length, 0);
  // 6 min despues: cooldown vencido → repite
  const r3 = computeAlerts({ mayRaw, smallRaw, cfg: cfgAlert, priceHist: r2.priceHist, cooldowns: r2.cooldowns, now: now + 6 * MIN });
  assert.equal(r3.alerts.length, 1);
});

test('spread bajo umbral no alerta', () => {
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 110 })], smallRaw: [rawAd({ price: 109.8 })],
    cfg: cfgAlert, priceHist: [], cooldowns: {}, now: 1000000000000,
  });
  assert.equal(r.alerts.length, 0);
});

test('sobrecomprado: +1% vs referencia de ~10 min', () => {
  const now = 1000000000000;
  const hist = [{ ts: now - 10 * MIN, price: 100 }, { ts: now - MIN, price: 100.5 }];
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 101.5 })], smallRaw: [],
    cfg: cfgAlert, priceHist: hist, cooldowns: {}, now,
  });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'overbought');
});

test('hueco en historial (>18 min) no genera momentum', () => {
  const now = 1000000000000;
  const hist = [{ ts: now - 30 * MIN, price: 100 }]; // referencia demasiado vieja
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 105 })], smallRaw: [],
    cfg: cfgAlert, priceHist: hist, cooldowns: {}, now,
  });
  assert.equal(r.alerts.length, 0);
});

test('debilidad: -0.5% vs referencia de ~10 min', () => {
  const now = 1000000000000;
  const hist = [{ ts: now - 10 * MIN, price: 100 }, { ts: now - MIN, price: 99.5 }];
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 99 })], smallRaw: [],
    cfg: cfgAlert, priceHist: hist, cooldowns: {}, now,
  });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].type, 'weakness');
});

test('silent: no alerta pero si actualiza historial', () => {
  const now = 1000000000000;
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 110 })], smallRaw: [rawAd({ price: 100 })],
    cfg: cfgAlert, priceHist: [], cooldowns: {}, now, silent: true,
  });
  assert.equal(r.alerts.length, 0);
  assert.equal(r.priceHist.length, 1);
  assert.equal(r.bestMay, 110);
});

test('sin mayoristas creibles → sin alertas ni push al historial', () => {
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 110, avail: 100 })], smallRaw: [],
    cfg: cfgAlert, priceHist: [], cooldowns: {}, now: 1000000000000,
  });
  assert.equal(r.bestMay, null);
  assert.equal(r.priceHist.length, 0);
});

test('historial acotado a 200 puntos', () => {
  const now = 1000000000000;
  const hist = Array.from({ length: 200 }, (_, i) => ({ ts: now - (200 - i) * 1000, price: 100 }));
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 100 })], smallRaw: [],
    cfg: cfgAlert, priceHist: hist, cooldowns: {}, now, silent: true,
  });
  assert.equal(r.priceHist.length, 200);
  assert.equal(r.priceHist[r.priceHist.length - 1].ts, now);
});

test('nick con HTML queda escapado en la alerta (Telegram)', () => {
  const r = computeAlerts({
    mayRaw: [rawAd({ price: 110, merchant: 'a<b&c' })], smallRaw: [rawAd({ price: 100 })],
    cfg: cfgAlert, priceHist: [], cooldowns: {}, now: 1000000000000,
  });
  assert.match(r.alerts[0].desc, /a&lt;b&amp;c/);
});
