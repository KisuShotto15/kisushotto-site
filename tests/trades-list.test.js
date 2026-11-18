// Lista de trades: pestana de estrategia, por revisar, orden por R, totales y TP del terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { _test } from '../workers/trade-journal-worker/src/index.js';

const W = new URL('../workers/trade-journal-worker/', import.meta.url);
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('schema.sql', W), 'utf8'));
for (const f of ['0001_r_multiple', '0004_settle_coin', '0006_stop_source', '0007_journal_config', '0009_execution', '0010_egress', '0011_btc_only', '0012_journal_sync', '0013_profiles', '0014_swing', '0015_fix_adopted']) {
  try { db.exec(readFileSync(new URL(`migrations/${f}.sql`, W), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
}
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
});
const env = { DB: { prepare: sql => stmt(sql) } };

const ins = db.prepare(`INSERT INTO trades (id, symbol, category, side, entry_price, exit_price, size, pnl, fees, entry_time, exit_time,
  strategy_tag, setup_tag, exec_type, notes, emotion, rule_score, status, exchange, exchange_id, created_at, risk_usd, stop_price)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'closed',?,?,0,?,?)`);
// VWAP del terminal, revisado, +2R
ins.run('a', 'BTCUSDT', 'linear', 'short', 100, 98, 1, 20, 1, 1000, 1100, 'VWAP', 'VWAP 2σ reversion', 'terminal', 'bien', 'calm', 9, 'bitget', 'tj:x1', 10, 101);
// Externa en Bitget sin etiqueta: cuenta como VWAP y falta revisarla, −1R
ins.run('b', 'BTCUSDT', 'linear', 'long', 100, 99, 1, -10, 1, 2000, 2100, null, null, 'external', null, null, null, 'bitget', 'h1', 10, 99);
// Swing en Binance, +0,5R, falta disciplina
ins.run('c', 'ETHUSDT', 'linear', 'long', 100, 105, 1, 5, 2, 3000, 3100, 'Swing', null, 'terminal', 'nota', 'calm', null, 'binance', 'tj:x2', 10, 90);
db.prepare("INSERT INTO exec_trades (id, exchange, market, symbol, side, status, tp, opened_at) VALUES ('x1','bitget','futures','BTCUSDT','short','closed',97,1000)").run();

const list = async q => (await _test.listTrades(new URL('https://w/trades?' + q), env)).json();

test('pestanas VWAP y Swing', async () => {
  assert.deepEqual((await list('strat=vwap')).trades.map(t => t.id), ['b', 'a']);
  assert.deepEqual((await list('strat=swing')).trades.map(t => t.id), ['c']);
  assert.equal((await list('')).trades.length, 3);
});

test('TP del terminal y orden por R', async () => {
  const { trades } = await list('sort=r');
  assert.deepEqual(trades.map(t => t.id), ['a', 'c', 'b']);
  assert.equal(trades.find(t => t.id === 'a').tp_price, 97);
});

test('totales de todo el filtro y por revisar', async () => {
  const { totals } = await list('strat=vwap&totals=1&limit=1');
  assert.equal(totals.n, 2);
  assert.equal(totals.wins, 1);
  assert.equal(totals.pnl, 10);
  assert.equal(totals.fees, 2);
  assert.equal(totals.r_sum, 1);
  assert.equal(totals.review, 1);
  const r = await list('review=1&totals=1');
  assert.deepEqual(r.trades.map(t => t.id).sort(), ['b', 'c']);
  assert.equal(r.totals.review, 2);
});
