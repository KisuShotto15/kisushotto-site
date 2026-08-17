import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPositionWindows, attachOpenTimes } from '../workers/trade-journal-worker/src/ingestion.js';

const T = 1_700_000_000_000;
const ex = (min, side, qty, o = {}) => ({
  symbol: 'SOLUSDT', side, execQty: String(qty), execType: 'Trade',
  execTime: String(T + min * 60_000), ...o,
});

test('la apertura es el primer fill, no el cierre', () => {
  const [w] = buildPositionWindows([ex(0, 'Buy', 10), ex(90, 'Sell', 10)]);
  assert.equal(w.openTime,  Math.floor(T / 1000));
  assert.equal(w.closeTime, Math.floor((T + 90 * 60_000) / 1000));
  assert.equal(w.side, 'long');
});

test('varias entradas parciales conservan la primera como apertura', () => {
  const [w] = buildPositionWindows([
    ex(0,  'Buy',  5),
    ex(10, 'Buy',  5),
    ex(60, 'Sell', 10),
  ]);
  assert.equal(w.openTime, Math.floor(T / 1000), 'la apertura es el fill mas antiguo');
  assert.equal((w.closeTime - w.openTime) / 60, 60, 'una hora de duracion');
});

test('las salidas parciales no cierran la posicion antes de tiempo', () => {
  const ws = buildPositionWindows([
    ex(0,  'Buy',  10),
    ex(30, 'Sell', 4),
    ex(90, 'Sell', 6),
  ]);
  assert.equal(ws.length, 1);
  assert.equal((ws[0].closeTime - ws[0].openTime) / 60, 90);
});

test('el funding se ignora: mueve el balance pero no la posicion', () => {
  const ws = buildPositionWindows([
    ex(0,  'Buy',  10),
    { ...ex(20, 'Sell', 10), execType: 'Funding' },
    ex(45, 'Sell', 10),
  ]);
  assert.equal(ws.length, 1);
  assert.equal((ws[0].closeTime - ws[0].openTime) / 60, 45);
});

test('un short se detecta y se mide igual', () => {
  const [w] = buildPositionWindows([ex(0, 'Sell', 8), ex(15, 'Buy', 8)]);
  assert.equal(w.side, 'short');
  assert.equal((w.closeTime - w.openTime) / 60, 15);
});

test('una inversion cierra una posicion y abre la siguiente', () => {
  const ws = buildPositionWindows([
    ex(0,  'Buy',  5),
    ex(30, 'Sell', 8),   // cierra el long y deja 3 en short
    ex(60, 'Buy',  3),
  ]);
  assert.equal(ws.length, 2);
  assert.equal(ws[0].side, 'long');
  assert.equal(ws[1].side, 'short');
  assert.equal(ws[1].openTime, ws[0].closeTime, 'la nueva abre donde cerro la anterior');
});

test('attachOpenTimes corrige la entrada emparejando por el cierre', () => {
  const close = Math.floor((T + 90 * 60_000) / 1000);
  const trades = [{ symbol: 'SOLUSDT', entry_time: close, exit_time: close, session: 'ny' }];
  const n = attachOpenTimes(trades, buildPositionWindows([ex(0, 'Buy', 10), ex(90, 'Sell', 10)]));
  assert.equal(n, 1);
  assert.equal(trades[0].entry_time, Math.floor(T / 1000));
  assert.equal(trades[0].exit_time - trades[0].entry_time, 5400, '90 minutos');
});

test('sin ventana que coincida no se toca el trade', () => {
  const lejos = Math.floor(T / 1000) + 999_999;
  const trades = [{ symbol: 'SOLUSDT', entry_time: lejos, exit_time: lejos }];
  const n = attachOpenTimes(trades, buildPositionWindows([ex(0, 'Buy', 10), ex(90, 'Sell', 10)]));
  assert.equal(n, 0);
  assert.equal(trades[0].entry_time, lejos, 'mejor dejarlo como estaba que inventar');
});

test('no se empareja un simbolo con las ventanas de otro', () => {
  const close = Math.floor((T + 90 * 60_000) / 1000);
  const trades = [{ symbol: 'BTCUSDT', entry_time: close, exit_time: close }];
  const n = attachOpenTimes(trades, buildPositionWindows([ex(0, 'Buy', 10), ex(90, 'Sell', 10)]));
  assert.equal(n, 0);
});
