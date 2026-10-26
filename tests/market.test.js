import { test } from 'node:test';
import assert from 'node:assert/strict';
import { histKey, fiatUnit, safeTz, zonedMinutes, zonedDateStr, zonedHm, zonedMidnight, DEFAULT_TZ } from '../api/_lib/market.js';
import { buildSearchBody } from '../api/_lib/binance.js';
import { computeAlerts } from '../api/_lib/monitor.js';

// ── Clave de la serie ─────────────────────────────────
test('histKey: VES conserva el metodo a secas (historial existente)', () => {
  assert.equal(histKey('VES', 'BancoDeVenezuela'), 'BancoDeVenezuela');
  assert.equal(histKey(undefined, 'Banesco'), 'Banesco');
});
test('histKey: otra moneda lleva prefijo (un mismo id de pago puede repetirse)', () => {
  assert.equal(histKey('USD', 'Zelle'), 'USD:Zelle');
  assert.equal(histKey('COP', 'BancolombiaSA'), 'COP:BancolombiaSA');
});

test('fiatUnit: Bs, $ y el codigo para lo demas', () => {
  assert.equal(fiatUnit('VES'), 'Bs');
  assert.equal(fiatUnit(undefined), 'Bs');
  assert.equal(fiatUnit('USD'), '$');
  assert.equal(fiatUnit('COP'), 'COP');
});

// ── Zona horaria ──────────────────────────────────────
test('safeTz: acepta IANA validas y cae al defecto con basura', () => {
  assert.equal(safeTz('America/Bogota'), 'America/Bogota');
  assert.equal(safeTz('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(safeTz('No/Existe'), DEFAULT_TZ);
  assert.equal(safeTz("'; DROP TABLE x; --"), DEFAULT_TZ);
  assert.equal(safeTz(''), DEFAULT_TZ);
  assert.equal(safeTz(null), DEFAULT_TZ);
});

const T = Date.UTC(2026, 0, 15, 3, 30); // 15 ene 2026 03:30 UTC
test('zonedMinutes/Hm/DateStr: Caracas (UTC-4) igual que el calculo fijo de antes', () => {
  assert.equal(zonedHm(T, 'America/Caracas'), '23:30');
  assert.equal(zonedMinutes(T, 'America/Caracas'), 23 * 60 + 30);
  assert.equal(zonedDateStr(T, 'America/Caracas'), '2026-01-14'); // aun es el dia anterior
});
test('zonedHm: otras zonas, con horario de verano', () => {
  assert.equal(zonedHm(T, 'Europe/Madrid'), '04:30');            // invierno, UTC+1
  const julio = Date.UTC(2026, 6, 15, 3, 30);
  assert.equal(zonedHm(julio, 'Europe/Madrid'), '05:30');        // verano, UTC+2
  assert.equal(zonedHm(T, 'America/Argentina/Buenos_Aires'), '00:30');
});
test('zonedMidnight: medianoche local en UTC', () => {
  assert.equal(zonedMidnight(T, 'America/Caracas'), Date.UTC(2026, 0, 14, 4, 0));
  assert.equal(zonedMidnight(T, 'Europe/Madrid'), Date.UTC(2026, 0, 14, 23, 0));
});

// ── Busqueda publica con moneda ───────────────────────
test('buildSearchBody: VES por defecto y la moneda pedida si viene', () => {
  assert.equal(buildSearchBody({ page: 1, pays: ['BancoDeVenezuela'] }).fiat, 'VES');
  const b = buildSearchBody({ page: 1, pays: ['Zelle'], fiat: 'USD', transAmount: 0 });
  assert.equal(b.fiat, 'USD');
  assert.equal(b.transAmount, undefined); // 0 = sin filtro de monto
});

// ── Unidad en las alertas ─────────────────────────────
function rawAd(price) {
  return { adv: { price: String(price), tradableQuantity: '5000' }, advertiser: { nickName: 'x', badges: ['v'] } };
}
test('computeAlerts: los textos usan la unidad de la moneda del monitor', () => {
  const base = { mayRaw: [rawAd(110)], smallRaw: [rawAd(100)], priceHist: [], cooldowns: {}, now: 1000000000000 };
  const ves = computeAlerts({ ...base, cfg: { spreadThr: 0.5 } });
  assert.match(ves.alerts[0].desc, / Bs \(/);
  const usd = computeAlerts({ ...base, cfg: { spreadThr: 0.5, fiat: 'USD' } });
  assert.match(usd.alerts[0].desc, / \$ \(/);
  assert.doesNotMatch(usd.alerts[0].desc, /Bs/);
});
