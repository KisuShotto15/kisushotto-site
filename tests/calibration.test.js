// Calibrar los pesos del motor contra lo que de verdad pasó en tus ventas.
//
// La maquinaria ya existía entera: el diario graba cada veredicto con sus
// señales, cruza esos veredictos contra las recompras reales de Binance sin que
// nadie marque nada, y calcula correlaciones y ajustes de peso. Lo único que
// faltaba era poder verlos y aplicarlos — la función de aplicar existía y no la
// llamaba nadie.
//
// Y faltaba algo que solo se hizo visible al corregir M5: los ciclos calificados
// con la versión anterior del motor NO pueden entrar en la calibración. Sus
// señales medían otra cosa, y mezclarlas fijaría ese error en los pesos nuevos.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

// El motor y el diario son dos IIFE al principio de main.js que se cuelgan de
// globalThis. Se cargan los dos: el resto del archivo es interfaz y toca el DOM.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/p2p-monitor/main.js'), 'utf8');
const FIN = '})(typeof window !== \'undefined\' ? window : globalThis);';
const corte = SRC.indexOf(FIN, SRC.indexOf(FIN) + 1) + FIN.length;
(0, eval)(SRC.slice(0, corte));
const { DE, DJ } = globalThis;

beforeEach(() => {
  store.clear();
  DJ.resetWeights();
});

const ciclo = (extra = {}) => ({
  status: 'closed', ev: DE.EV,
  rebuy: { netPct: 0.005, success: 'win', minutesElapsed: 6 },
  features: { spreadNet: 0.006 },
  ...extra,
});

// ── Qué ciclos entran en la calibración ─────────────────────────────────────

test('los ciclos del motor actual cuentan', () => {
  const r = DJ.closedTrades([ciclo(), ciclo(), ciclo()]);
  assert.equal(r.usables.length, 3);
  assert.equal(r.otroMotor, 0);
});

test('los de una versión anterior quedan fuera, y se dice cuántos', () => {
  // Tras corregir M5, la ventana del máximo reciente pasó a medir 20 minutos de
  // verdad en vez de 7,5. Un ciclo de antes trae un revProb que describe otra cosa.
  const r = DJ.closedTrades([ciclo(), ciclo({ ev: 1 }), ciclo({ ev: 1 })]);
  assert.equal(r.usables.length, 1);
  assert.equal(r.otroMotor, 2, 'se reportan: "0 ciclos" sin explicación parece que el diario se perdió');
});

test('un ciclo sin versión es de antes de que se sellara', () => {
  const sinEv = ciclo();
  delete sinEv.ev;
  const r = DJ.closedTrades([sinEv]);
  assert.equal(r.usables.length, 0);
  assert.equal(r.otroMotor, 1);
});

test('las ventas abiertas o abandonadas no son ciclos calificados', () => {
  const r = DJ.closedTrades([
    ciclo({ status: 'open', rebuy: null }),
    ciclo({ status: 'abandoned', rebuy: null }),
    ciclo(),
  ]);
  assert.equal(r.usables.length, 1);
  assert.equal(r.otroMotor, 0, 'tampoco cuentan como "de otro motor"');
});

test('una venta cerrada sin recompra registrada no califica nada', () => {
  assert.equal(DJ.closedTrades([ciclo({ rebuy: null })]).usables.length, 0);
});

// ── Repasar un cambio antes de hacerlo ──────────────────────────────────────

const SUGS = [{ feature: 'spreadNet', weightKey: 'spread', current: 30, suggested: 36, ir: 0.4 }];

test('los pesos propuestos no tocan los que están en uso', () => {
  // Si el repaso compartiera referencia con los pesos vivos, mirar el cambio
  // sería aplicarlo.
  const antes = DE.WEIGHTS.spread;
  const w = DJ.weightsWith(SUGS);
  assert.equal(w.spread, 36);
  assert.equal(DE.WEIGHTS.spread, antes, 'los vigentes siguen intactos');
});

test('los pesos propuestos llevan también los que no cambian', () => {
  const w = DJ.weightsWith(SUGS);
  assert.equal(w.abs, DE.WEIGHTS.abs, 'score() necesita el juego completo');
  assert.equal(Object.keys(w).length, Object.keys(DE.WEIGHTS).length);
});

test('una sugerencia sobre un peso que no existe se ignora', () => {
  const w = DJ.weightsWith([{ weightKey: 'inventado', suggested: 99 }]);
  assert.equal(w.inventado, undefined);
});

test('sin sugerencias se devuelven los pesos tal cual', () => {
  assert.deepEqual(DJ.weightsWith([]), DE.WEIGHTS);
  assert.deepEqual(DJ.weightsWith(null), DE.WEIGHTS);
});

test('el backtest con pesos distintos da resultados distintos', () => {
  // Es lo que hace útil el repaso: si los pesos no movieran el puntaje, comparar
  // no diría nada.
  const F = { degraded: false, spreadNet: 0.008, LA: 200000, LB: 50000, HHI: 0.25,
    topUSDT: 150000, majorCount: 5, absRate3m: 0.05, gapMaxRel: 0.0005, gapBigCnt: 0,
    weakness: 0.1, momentum: 0, revProb: 0, buyAbsRate3m: 0.1, events: {}, avgMajorOrder: 30000 };
  const a = DE.score(F).raw;
  const b = DE.score(F, DJ.weightsWith(SUGS)).raw;
  assert.notEqual(a.toFixed(4), b.toFixed(4));
});

// ── Aplicar y deshacer ──────────────────────────────────────────────────────

test('aplicar cambia los pesos y los deja guardados', () => {
  DJ.applySuggestions(SUGS);
  assert.equal(DE.WEIGHTS.spread, 36);
  assert.ok(localStorage.getItem('p2p-de-weights'), 'sobreviven al recargar');
});

test('se puede deshacer una calibración mala', () => {
  // Sin esto, aplicar era una vía de un solo sentido desde la app.
  DJ.applySuggestions(SUGS);
  DJ.resetWeights();
  assert.equal(DE.WEIGHTS.spread, DE.DEFAULT_WEIGHTS.spread);
  assert.equal(localStorage.getItem('p2p-de-weights'), null, 'y no vuelven al recargar');
});

test('los pesos de fábrica no se mueven aunque se calibre', () => {
  DJ.applySuggestions(SUGS);
  assert.equal(DE.DEFAULT_WEIGHTS.spread, 30, 'si fuera la misma referencia, no habría a qué volver');
});

// ── Los pesos guardados también caducan con el motor ────────────────────────

test('unos pesos guardados con este motor se recuperan', () => {
  DJ.applySuggestions(SUGS);
  DJ.resetWeights.call(null);
  DE.WEIGHTS.spread = 30;
  store.set('p2p-de-weights', JSON.stringify({ ev: DE.EV, w: { spread: 36 } }));
  DJ.loadPersistedWeights();
  assert.equal(DE.WEIGHTS.spread, 36);
});

test('unos pesos calibrados sobre el motor viejo se descartan', () => {
  // Venían de correlaciones sobre señales que medían otra cosa.
  store.set('p2p-de-weights', JSON.stringify({ ev: DE.EV - 1, w: { spread: 99 } }));
  DJ.loadPersistedWeights();
  assert.equal(DE.WEIGHTS.spread, DE.DEFAULT_WEIGHTS.spread);
  assert.equal(localStorage.getItem('p2p-de-weights'), null, 'y se limpian, no se releen cada vez');
});

test('el formato anterior (sin versión) se descarta', () => {
  store.set('p2p-de-weights', JSON.stringify({ spread: 99, abs: 99 }));
  DJ.loadPersistedWeights();
  assert.equal(DE.WEIGHTS.spread, DE.DEFAULT_WEIGHTS.spread);
});

test('un valor corrupto no rompe el arranque', () => {
  store.set('p2p-de-weights', 'esto no es json');
  assert.doesNotThrow(() => DJ.loadPersistedWeights());
  assert.equal(DE.WEIGHTS.spread, DE.DEFAULT_WEIGHTS.spread);
});

// ── La versión del motor ────────────────────────────────────────────────────

test('el motor declara su versión y el diario la sella', () => {
  assert.ok(DE.EV >= 2, 'subió al corregir M5');
  assert.equal(DJ.currentEV(), DE.EV);
  const src = SRC.slice(0, corte);
  assert.match(src, /ev: \(root\.DE && root\.DE\.EV\) \|\| 1/, 'cada veredicto grabado lleva la versión');
});
