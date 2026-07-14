// Tests de computeReprice (logica de dinero del bot). Corre con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReprice, adPayTypes } from '../api/_lib/reprice.js';

// Anuncio de mercado en el formato crudo de Binance P2P
function rawAd({ advNo = 'X1', price, minVES = 100, maxVES = 50000, avail = 500, merchant = 'otro', payTypes = ['BancoDeVenezuela'], badges = ['verified'] } = {}) {
  return {
    adv: {
      advNo,
      price: String(price),
      minSingleTransAmount: String(minVES),
      maxSingleTransAmount: String(maxVES),
      tradableQuantity: String(avail),
      tradeMethods: payTypes.map(id => ({ identifier: id })),
    },
    advertiser: { nickName: merchant, badges },
  };
}

const myAd = (over = {}) => ({
  advNo: 'MIO',
  price: '110.000',
  minSingleTransAmount: '5000',
  tradeMethods: [{ identifier: 'BancoDeVenezuela' }],
  ...over,
});

// cfg base: sellPrice 115, minSpread 2% → techo = 115 * 0.98 = 112.7
const baseCfg = { sellPrice: 115, minSpread: 2, commission: 0, increment: 0.001, maxGap: 1.0, myNick: 'yo' };

test('precio sobre techo → baja al techo', () => {
  const r = computeReprice({ ad: myAd({ price: '113.5' }), marketRaw: [], cfg: baseCfg });
  assert.equal(r.targetPrice, 112.7);
  assert.match(r.reason, /techo/);
});

test('competidor arriba dentro del gap → sube a su precio + increment', () => {
  const market = [rawAd({ price: 110.5 })];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.targetPrice, 110.501);
});

test('competidor arriba fuera del gap → en espera (no mueve)', () => {
  const market = [rawAd({ price: 112 })]; // gap 2 > maxGap 1
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.targetPrice, null);
  assert.match(r.reason, /espera/);
});

test('solo competidores abajo → baja a mejor + increment (ahorro)', () => {
  const market = [rawAd({ price: 108 }), rawAd({ advNo: 'X2', price: 109 })];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.targetPrice, 109.001);
  assert.match(r.reason, /ahorro/);
});

test('target sobre techo se recorta al techo', () => {
  // techo = 115*0.975 = 112.125; competidor 112.1 + increment 0.05 = 112.15 → recorte
  const cfg = { ...baseCfg, minSpread: 2.5, increment: 0.05 };
  const r = computeReprice({ ad: myAd({ price: '112.0' }), marketRaw: [rawAd({ price: 112.1 })], cfg });
  assert.equal(r.targetPrice, 112.125);
  assert.match(r.reason, /\[techo\]/);
});

test('cambio menor a 0.001 → posicion optima (no mueve)', () => {
  const market = [rawAd({ price: 107.9995 })];
  const r = computeReprice({ ad: myAd({ price: '108.0' }), marketRaw: market, cfg: baseCfg });
  assert.equal(r.targetPrice, null);
  assert.match(r.reason, /ptima/);
});

test('sin competidores → posicion optima', () => {
  const r = computeReprice({ ad: myAd(), marketRaw: [], cfg: baseCfg });
  assert.equal(r.targetPrice, null);
  assert.equal(r.competitors, 0);
});

test('filtra mi propio anuncio y mi nick', () => {
  const market = [
    rawAd({ advNo: 'MIO', price: 111 }),
    rawAd({ price: 111.5, merchant: 'yo' }),
  ];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.competitors, 0);
});

test('filtra competidores con minVES alto, poca disponibilidad y sin badge', () => {
  const market = [
    rawAd({ price: 111, minVES: 5000 }),            // minVES no < 5000+0
    rawAd({ advNo: 'X2', price: 111, avail: 100 }), // avail < 150
    rawAd({ advNo: 'X3', price: 111, badges: [] }), // sin badge (verifiedOnly default)
  ];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.competitors, 0);
});

test('verifiedOnly:false acepta anuncios sin badge', () => {
  const market = [rawAd({ price: 110.5, badges: [] })];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: { ...baseCfg, verifiedOnly: false } });
  assert.equal(r.competitors, 1);
});

test('filtra por metodo de pago cuando no coincide', () => {
  const market = [rawAd({ price: 110.5, payTypes: ['Zinli'] })];
  const r = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  assert.equal(r.competitors, 0);
});

test('limitThreshold amplia el corte de minVES', () => {
  const market = [rawAd({ price: 110.5, minVES: 5500 })];
  const sin = computeReprice({ ad: myAd(), marketRaw: market, cfg: baseCfg });
  const con = computeReprice({ ad: myAd(), marketRaw: market, cfg: { ...baseCfg, limitThreshold: 1000 } });
  assert.equal(sin.competitors, 0);
  assert.equal(con.competitors, 1);
});

test('comision reduce el techo', () => {
  // techo = 115 * (1 - (2+1)/100) = 111.55
  const r = computeReprice({ ad: myAd({ price: '112.0' }), marketRaw: [], cfg: { ...baseCfg, commission: 1 } });
  assert.equal(r.targetPrice, 111.55);
});

test('sobre techo con competidor arriba del techo → baja al mejor bajo techo', () => {
  // techo real 838.9996; el precio publicado quedo en 839.000 por redondeo toFixed(3).
  // Competidor en 840 (sobre techo, se ignora) y en 835 → debe bajar a 835.001,
  // no quedarse pegado al techo como "posicion optima".
  const cfg = { ...baseCfg, sellPrice: 856.122, minSpread: 2 }; // techo = 838.99956
  const market = [rawAd({ price: 840 }), rawAd({ advNo: 'X2', price: 835 })];
  const r = computeReprice({ ad: myAd({ price: '839.000' }), marketRaw: market, cfg });
  assert.equal(r.targetPrice, 835.001);
});

test('sobre techo sin competidores bajo techo → baja al techo sin excederlo', () => {
  const cfg = { ...baseCfg, sellPrice: 856.122, minSpread: 2 }; // techo = 838.99956
  const r = computeReprice({ ad: myAd({ price: '839.000' }), marketRaw: [rawAd({ price: 840 })], cfg });
  assert.equal(r.targetPrice, 838.999); // toFixed daria 839.000 (> techo); se recorta
});

test('adPayTypes ignora ids genericos', () => {
  const ad = { tradeMethods: [{ identifier: 'BancoDeVenezuela' }, { identifier: 'OtherPayments' }, { identifier: 'SpecificBank' }] };
  assert.deepEqual(adPayTypes(ad), ['BancoDeVenezuela']);
});
