// Flujo completo del terminal contra un exchange simulado y D1 sobre node:sqlite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ExchangeGateway } from '../workers/trade-journal-worker/src/gateway.js';
import { DEFAULT_RULES } from '../workers/trade-journal-worker/src/risk.js';

const W = new URL('../workers/trade-journal-worker/', import.meta.url);

// ── D1 minimo ────────────────────────────────────────────────────────────────
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('schema.sql', W), 'utf8'));
  for (const f of ['0004_settle_coin', '0006_stop_source', '0007_journal_config', '0009_execution', '0010_egress']) {
    db.exec(readFileSync(new URL(`migrations/${f}.sql`, W), 'utf8'));
  }
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { raw: db, prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); } };
}

// ── Exchange simulado ────────────────────────────────────────────────────────
function fakeExchange() {
  const st = { equity: 1000, positions: [], price: 100, calls: [], pnl: -10 };
  const inst = { symbol: 'BTCUSDT', tick: 0.01, step: 0.001, min_qty: 0.001, min_notional: 5, fee: 0.0006, max_leverage: 50, base: 'BTC' };
  const api = {
    name: 'bitget',
    equity: async () => ({ futures_equity: st.equity, futures_available: st.equity, spot_value: 0, total: st.equity, errors: [] }),
    futuresPositions: async () => st.positions.map(p => ({ ...p, mark: st.price })),
    spotHoldings: async () => [{ exchange: 'bitget', market: 'spot', asset: 'USDT', symbol: 'USDTUSDT', qty: 500, free: 500, price: 1, value: 500, stable: true }],
    instrument: async () => inst,
    price: async () => st.price,
    klines: async () => [],
    openFutures: async o => {
      st.calls.push(['open', o]);
      st.positions.push({ exchange: 'bitget', market: 'futures', symbol: o.symbol, side: o.side, size: o.qty, entry: st.price, stop: o.stop, tp: o.tp, stop_refs: [] });
      return { order_id: '1', filled: true };
    },
    setStop: async (pos, stop) => { st.calls.push(['stop', stop]); st.positions.find(p => p.symbol === pos.symbol).stop = stop; },
    reduce: async (pos, qty) => { st.calls.push(['reduce', qty]); st.positions.find(p => p.symbol === pos.symbol).size -= qty; },
    closePosition: async pos => { st.calls.push(['close', pos.symbol]); st.positions = st.positions.filter(p => p.symbol !== pos.symbol); },
    orderState: async () => ({ state: 'open' }), cancelOrder: async () => {}, cleanup: async () => {},
    closedPnl: async () => ({ pnl: st.pnl, exit_price: 98, closed_at: Math.floor(Date.now() / 1000) }),
    spotStopOrders: async () => [], spotPlaceStop: async () => {}, openSpot: async () => ({}), spotClose: async () => {}, spotPnl: async () => null,
    diag: async () => ({ ok: true }),
  };
  return { st, api };
}

// Martes 2026-11-10 10:00 NY (UTC-5): dentro de la ventana
let clock = Date.UTC(2026, 10, 10, 15, 0);
const realNow = Date.now;
Date.now = () => clock;
globalThis.fetch = async () => new Response(JSON.stringify([
  { title: 'CPI m/m', country: 'USD', date: '2026-11-12T08:30:00-05:00', impact: 'High' },
  { title: 'Speech', country: 'AUD', date: '2026-11-08T17:30:00-05:00', impact: 'Low' },
]), { status: 200 });

const { st, api } = fakeExchange();
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...r) => String(u).includes('faireconomy') ? realFetch(u, ...r)
  : new Response(String(u).includes('trace') ? 'colo=AMS\nloc=NL\n' : '{}', { status: 200 });
const DB = d1();
const gw = new ExchangeGateway({}, { DB, KEYS_SECRET: 'test-secret-1234567890', ADAPTER: () => api, DETECT_MODE: async () => 'classic' });
const call = async (path, body, method = body ? 'POST' : 'GET') => {
  const res = await gw.fetch(new Request(`https://gw/exec${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return res.json();
};
const order = (o = {}) => ({ exchange: 'bitget', market: 'futures', symbol: 'BTCUSDT', side: 'long', type: 'market',
                              stop: 98, tp: 104, checklist: DEFAULT_RULES.checklist, setup: 'VWAP -2σ', ...o });

test('cuenta: se guarda cifrada y arranca en simulacion', async () => {
  const r = await call('/accounts', { exchange: 'bitget', key: 'k', secret: 's', passphrase: 'p' });
  assert.equal(r.ok, true);
  const row = DB.raw.prepare('SELECT * FROM exec_accounts').get();
  assert.equal(row.dry_run, 1);
  assert.ok(!row.secret_enc.includes('s.') && row.secret_enc !== 's');
  await call('/news/refresh', {});
  const sim = await call('/order', order());
  assert.equal(sim.simulated, true);
  assert.equal(st.calls.length, 0);
});

test('orden real: tamano por riesgo, stop puesto, registrada en el libro', async () => {
  await call('/accounts/mode', { exchange: 'bitget', dry_run: false });
  const pre = await call('/preview', order());
  assert.equal(pre.ok, true, pre.errors?.join());
  assert.ok(pre.plan.risk_usd <= 10 && pre.plan.risk_usd > 9);
  const r = await call('/order', order());
  assert.equal(r.ok, true, r.errors?.join());
  assert.equal(st.positions.length, 1);
  assert.equal(st.positions[0].stop, 98);
  const t = DB.raw.prepare("SELECT * FROM exec_trades WHERE status='open'").get();
  assert.equal(t.symbol, 'BTCUSDT');
  assert.ok(t.risk_usd <= 10);
});

test('no se promedia: segunda orden en el mismo simbolo se rechaza', async () => {
  const r = await call('/order', order());
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /no se promedia/);
});

test('el stop no se puede alejar desde el terminal', async () => {
  const r = await call('/stop', { exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', stop: 95 });
  assert.match(r.error, /solo se puede mover a favor/);
  const ok = await call('/stop', { exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', stop: 99 });
  assert.equal(ok.ok, true);
});

test('guardian: si alejas el stop en la app del exchange, lo devuelve', async () => {
  st.positions[0].stop = 90;
  clock += 120000;
  await call('/guardian', {});
  assert.equal(st.positions[0].stop, 99);
  assert.deepEqual(st.calls.at(-1), ['stop', 99]);
});

test('guardian: al cerrarse, pasa al journal en R y activa la pausa', async () => {
  st.positions = [];
  st.equity = 990;
  clock += 60000;
  await call('/guardian', {});
  const t = DB.raw.prepare("SELECT * FROM exec_trades WHERE symbol='BTCUSDT'").get();
  assert.equal(t.status, 'closed');
  assert.ok(t.r < -0.9);
  const j = DB.raw.prepare("SELECT * FROM trades WHERE exchange_id = ?").get(`tj:${t.id}`);
  assert.equal(j.pnl, -10);
  assert.equal(j.stop_price, 98);
  assert.equal(j.strategy_tag, 'VWAP');
  const r = await call('/preview', order({ symbol: 'ETHUSDT' }));
  assert.match(r.errors.join(), /Pausa tras perdida/);
});

test('dos perdidas seguidas bloquean el dia', async () => {
  clock += 31 * 60000;
  const r = await call('/order', order({ symbol: 'ETHUSDT' }));
  assert.equal(r.ok, true, r.errors?.join());
  st.positions = [];
  st.equity = 980;
  clock += 120000;
  await call('/guardian', {});
  const s = await call('/status?fresh=1');
  assert.ok(s.lock, 'debe quedar bloqueado');
  assert.match(s.lock.reason, /perdidas seguidas/);
  clock += 3 * 3600000;   // aunque pase el tiempo de pausa, el bloqueo sigue
  const again = await call('/preview', order({ symbol: 'SOLUSDT' }));
  assert.equal(again.ok, false);
});

test('guardian: posicion abierta por fuera mientras esta bloqueado se cierra', async () => {
  st.positions.push({ exchange: 'bitget', market: 'futures', symbol: 'SOLUSDT', side: 'short', size: 5, entry: 100, stop: null, stop_refs: [] });
  clock += 60000;
  await call('/guardian', {});
  assert.equal(st.positions.length, 0);
  assert.deepEqual(st.calls.at(-1), ['close', 'SOLUSDT']);
  const ev = DB.raw.prepare("SELECT * FROM risk_events WHERE kind='guardian' ORDER BY id DESC").get();
  assert.match(ev.message, /fuera del sistema/);
});

test('dia de noticias: no se opera', async () => {
  // jueves 12, CPI
  clock = Date.UTC(2026, 10, 12, 15, 0);
  DB.raw.exec('UPDATE risk_state SET lock_until = 0');
  const r = await call('/preview', order({ symbol: 'XRPUSDT' }));
  assert.match(r.errors.join(), /noticias/);
  Date.now = realNow;
});
