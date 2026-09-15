// El motor de decisión: que mida lo que dice medir, y que diga lo que mide.
//
// Dos problemas distintos, los dos de coherencia y no de cálculo:
//
//  1. El buffer guardaba 30 instantáneas. Con el refresco por defecto de 15 s eso
//     son 7,5 minutos, pero la señal "estamos cerca del máximo reciente" declaraba
//     una ventana de 20. El motor no medía lo que su autor creía, y eso corrompe
//     cualquier calibración posterior contra resultados reales.
//  2. La probabilidad de reversión SUMA al puntaje de venta (peso 8) y recorta la
//     ventana de recompra, pero se mostraba entre las razones EN CONTRA. El panel
//     podía decir "SELL, puntaje 71" y listar como argumento negativo uno de los
//     factores que había subido ese 71.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// El motor es un IIFE al principio de main.js que se cuelga de globalThis. Se
// carga solo ese bloque: el resto del archivo es interfaz y toca el DOM.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/p2p-monitor/main.js'), 'utf8');
const FIN = '})(typeof window !== \'undefined\' ? window : globalThis);';
const ENGINE = SRC.slice(0, SRC.indexOf(FIN) + FIN.length);
(0, eval)(ENGINE);
const DE = globalThis.DE;

// Un anuncio mayorista creíble: isMajor exige rango < 10 y disponible >= 10000.
const ad = (merchant, price, avail = 50000) => ({
  merchant, price, avail, min: 100, max: avail, verified: true, orders: 500, rate: 98,
});
// Estado del libro tal como lo arma la vista.
const book = (price, extra = {}) => ({
  mayoristas: [ad('A', price), ad('B', price + 0.02), ad('C', price + 0.04),
               ad('D', price + 0.06), ad('E', price + 0.08)],
  smallAds: [ad('S1', price + 0.1, 2000)],
  buyAds: [ad('X', price - 0.5, 60000), ad('Y', price - 0.55, 40000)],
  ...extra,
});

// ── El buffer cubre la ventana que declara ──────────────────────────────────

test('el buffer ya no se corta a 30 instantáneas', () => {
  // 20 minutos a 15 s son 80 instantáneas. Con el tope viejo cabían 30, y el
  // filtro de REV_WIN_MS no descartaba nunca nada porque no había nada tan viejo.
  const h = [];
  const t0 = Date.now();
  for (let i = 0; i < 80; i++) {
    const real = Date.now;
    Date.now = () => t0 + i * 15000;
    try { DE.pushSnapshot(h, book(300)); } finally { Date.now = real; }
  }
  assert.ok(h.length > 30, 'con 80 refrescos de 15 s no puede quedar el tope viejo');
  assert.equal(h.length, 80, 'ninguno de los 20 minutos se descarta');
});

test('lo más viejo que la ventana sí se descarta', () => {
  const h = [];
  const t0 = Date.now();
  // Una hora de refrescos cada 15 s.
  for (let i = 0; i < 240; i++) {
    const real = Date.now;
    Date.now = () => t0 + i * 15000;
    try { DE.pushSnapshot(h, book(300)); } finally { Date.now = real; }
  }
  const span = (h[h.length - 1].ts - h[0].ts) / 60000;
  assert.ok(span <= 23, 'no se acumula una hora entera en memoria: ' + span.toFixed(1) + ' min');
  assert.ok(span >= 20, 'pero sí cubre los 20 minutos que declara: ' + span.toFixed(1) + ' min');
});

test('el buffer se mide en tiempo, no en refrescos', () => {
  // El refresco es configurable (10 s o más), así que el mismo número de
  // instantáneas cubre ventanas distintas según cómo lo tenga ajustado cada quien.
  const cubierto = paso => {
    const h = [];
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
      const real = Date.now;
      Date.now = () => t0 + i * paso;
      try { DE.pushSnapshot(h, book(300)); } finally { Date.now = real; }
    }
    return (h[h.length - 1].ts - h[0].ts) / 60000;
  };
  const a = cubierto(10000), b = cubierto(30000);
  assert.ok(Math.abs(a - b) < 1.5,
    'a 10 s y a 30 s se cubre la misma ventana (' + a.toFixed(1) + ' vs ' + b.toFixed(1) + ' min)');
});

test('el tope de memoria sigue existiendo', () => {
  // Si algo empezara a empujar instantáneas sin avanzar el reloj, el buffer no
  // puede crecer sin límite.
  const h = [];
  for (let i = 0; i < 500; i++) DE.pushSnapshot(h, book(300));
  assert.ok(h.length <= 300, 'quedaron ' + h.length);
});

test('el máximo reciente mira toda la ventana, no solo el último tramo', () => {
  const h = [];
  const t0 = Date.now();
  const real = Date.now;
  try {
    // Un pico de precio hace 15 minutos, y después precio plano más bajo.
    for (let i = 0; i < 80; i++) {
      Date.now = () => t0 + i * 15000;
      DE.pushSnapshot(h, book(i === 20 ? 305 : 300));
    }
    Date.now = () => t0 + 80 * 15000;
    const F = DE.computeFeatures(book(300), h);
    assert.ok(F.hi20 >= 305, 'el pico de hace 15 min sigue contando: hi20=' + F.hi20);
  } finally { Date.now = real; }
});

// ── La reversión se presenta como lo que suma ───────────────────────────────

const featuresConRev = rev => ({
  degraded: false, pSell: 300, pRebuy: 298,
  spreadNet: 0.006, spreadGross: 0.008, LA: 200000, LB: 100000,
  HHI: 0.3, topUSDT: 150000, majorCount: 5,
  absRate3m: 0.25, replenishRate: 0.1, prevTop5USDT: 150000,
  buyAbsRate3m: 0.1, buyReplenishRate: 0.1,
  gapMaxRel: 0.0005, gapBigCnt: 0,
  weakness: 0.1, priceDirAdj: 0, priceMom: 0.001, flowMom: 0.1, momentum: 0.2,
  revProb: rev, hi20: 300,
  events: { rapidDeplete: false, top1Gone: false, priceDropTop: false },
  avgMajorOrder: 30000,
});

test('la reversión sube el puntaje de venta', () => {
  // Esto ya era así; se fija para que el resto del test signifique algo.
  const bajo = DE.score(featuresConRev(0)).raw;
  const alto = DE.score(featuresConRev(1)).raw;
  assert.ok(alto > bajo, 'peso 8 a favor de vender');
});

test('lo que sube el puntaje no puede aparecer como razón en contra', () => {
  const F = featuresConRev(0.8);
  const d = DE.decide(F, DE.score(F));
  assert.ok(!d.reasons.neg.some(r => /reversión/i.test(r)),
    'aparecía entre los argumentos negativos habiendo subido el puntaje: ' + JSON.stringify(d.reasons.neg));
  assert.ok(d.reasons.pos.some(r => /ventana se está cerrando/.test(r)),
    'y la razón real es urgencia: la ventana se cierra');
});

test('con reversión baja no se dice nada de la ventana', () => {
  const F = featuresConRev(0.2);
  const d = DE.decide(F, DE.score(F));
  assert.ok(!d.reasons.pos.some(r => /ventana se está cerrando/.test(r)));
  assert.ok(!d.reasons.neg.some(r => /reversión/i.test(r)));
});

test('el porcentaje mostrado es el mismo que entró al puntaje', () => {
  const F = featuresConRev(0.73);
  const d = DE.decide(F, DE.score(F));
  const linea = d.reasons.pos.find(r => /ventana se está cerrando/.test(r));
  assert.match(linea, /73\s?%/);
});

test('el choque entre impulso al alza y reversión sigue señalándose', () => {
  // Bajo la lectura de urgencia las dos señales tiran en sentidos contrarios:
  // el precio sube (espera) pero la ventana se cierra (vende ya). Eso es un
  // conflicto de verdad y el usuario tiene que verlo.
  const F = { ...featuresConRev(0.8), momentum: 0.5 };
  const d = DE.decide(F, DE.score(F));
  assert.ok(d.conflicts.some(c => /impulso al alza pero reversión probable/.test(c)));
});

test('los tres usos de la reversión tiran en el mismo sentido', () => {
  // Suma al puntaje, acorta la ventana de recompra y sube la confianza en ella.
  // Si alguno se invirtiera, el motor volvería a contradecirse.
  const sinRev = featuresConRev(0);
  const conRev = featuresConRev(0.9);
  const a = DE.decide(sinRev, DE.score(sinRev)).rebuy;
  const b = DE.decide(conRev, DE.score(conRev)).rebuy;
  assert.ok(a && b, 'ambos casos llegan a un veredicto de venta');
  assert.ok(b.min <= a.min, 'reversión probable acorta la espera para recomprar');
  assert.ok(b.conf > a.conf, 'y la estimación es más firme, no menos');
});
