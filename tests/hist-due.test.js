// histDue (bot-tick.js): decide si toca agregar punto a hist24/hist_long mirando solo
// el ts del ultimo punto. Tiene que seguir las mismas reglas que pushHist24/pushHistLong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { histDue } from '../api/bot-tick.js';
import { pushHist24, pushHistLong } from '../api/_lib/monitor.js';

test('histDue: serie vacia o NULL → agrega a las dos', () => {
  assert.deepEqual(histDue(undefined, 1000, 5), { add24: true, addLong: true });
  assert.deepEqual(histDue({ last24: null, last_long: null }, 1000, 5), { add24: true, addLong: true });
});

test('histDue: sin precio no agrega nada', () => {
  assert.deepEqual(histDue({}, 1000, 0), { add24: false, addLong: false });
  assert.deepEqual(histDue({}, 1000, null), { add24: false, addLong: false });
});

test('histDue: coincide con pushHist24/pushHistLong', () => {
  const t0 = 1_700_000_000_000;
  for (const dt of [0, 60_000, 119_999, 120_000, 599_999, 600_000, 3_600_000]) {
    const now = t0 + dt;
    // postgres devuelve bigint como string: histDue lo convierte
    const due = histDue({ last24: String(t0), last_long: String(t0) }, now, 7);
    assert.equal(due.add24, pushHist24([{ ts: t0, price: 1 }], now, 7).length === 2, 'hist24 dt=' + dt);
    assert.equal(due.addLong, pushHistLong([{ ts: t0, price: 1 }], now, 7).length === 2, 'histLong dt=' + dt);
  }
});
