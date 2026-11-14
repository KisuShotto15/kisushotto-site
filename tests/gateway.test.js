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
  for (const f of ['0004_settle_coin', '0006_stop_source', '0007_journal_config', '0009_execution', '0010_egress', '0011_btc_only', '0012_journal_sync', '0013_profiles', '0014_swing']) {
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
    closedHistory: async () => st.history || [],
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
// Binance: cuenta de swing con longs en USDT-M y COIN-M
const bn = fakeExchange();
bn.st.equity = 5000;
bn.api.name = 'binance';
bn.api.coinm = async () => ({ value: 2000, positions: [{ exchange: 'binance', market: 'coinm', symbol: 'BTCUSD_PERP', side: 'long', size: 3, entry: 60000, mark: 61000, upnl: 50, upnl_coin: 0.0008, settle_coin: 'BTC', notional: 300 }] });
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...r) => String(u).includes('faireconomy') ? realFetch(u, ...r)
  : new Response(String(u).includes('trace') ? 'colo=AMS\nloc=NL\n' : '{}', { status: 200 });
const DB = d1();
// Estas pruebas usan varios simbolos; la regla de solo BTC tiene su propia prueba
DB.raw.prepare("INSERT INTO risk_rules (id, rules, updated_at) VALUES ('main', ?, 0)").run(JSON.stringify({ ...DEFAULT_RULES, symbols: [] }));
const gw = new ExchangeGateway({}, { DB, KEYS_SECRET: 'test-secret-1234567890', ADAPTER: acc => acc.exchange === 'binance' ? bn.api : api, DETECT_MODE: async () => 'classic' });
const call = async (path, body, method = body ? 'POST' : 'GET') => {
  const res = await gw.fetch(new Request(`https://gw/exec${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return res.json();
};
const order = (o = {}) => ({ exchange: 'bitget', market: 'futures', symbol: 'BTCUSDT', side: 'long', type: 'market',
                              stop: 99.7, tp: 100.6, checklist: DEFAULT_RULES.checklist, setup: 'VWAP -2σ', ...o });

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

test('al pasar a real, una posicion previa se adopta en vez de cerrarse', async () => {
  st.positions.push({ exchange: 'bitget', market: 'futures', symbol: 'ADAUSDT', side: 'long', size: 10, entry: 100, stop: 99.5, stop_refs: [] });
  const m = await call('/accounts/mode', { exchange: 'bitget', dry_run: false });
  assert.equal(m.ok, true, JSON.stringify(m));
  const t = DB.raw.prepare("SELECT * FROM exec_trades WHERE symbol='ADAUSDT'").get();
  assert.equal(t.status, 'open');
  assert.equal(t.external, 1);
  st.positions = [];
  clock += 120000;
  await call('/guardian', {});
  assert.equal(DB.raw.prepare("SELECT status FROM exec_trades WHERE symbol='ADAUSDT'").get().status, 'closed');
  // la adoptada cerro con perdida: limpiar para que no afecte las pruebas siguientes
  DB.raw.exec("DELETE FROM exec_trades WHERE symbol='ADAUSDT'");
  DB.raw.exec("DELETE FROM trades WHERE symbol='ADAUSDT'");
  st.calls.length = 0;
});

test('orden real: tamano por riesgo, stop puesto, registrada en el libro', async () => {
  const pre = await call('/preview', order());
  assert.equal(pre.ok, true, pre.errors?.join());
  assert.ok(pre.plan.risk_usd <= 10 && pre.plan.risk_usd > 9);
  assert.equal(pre.plan.leverage, 50);   // 51x pedido, el simbolo admite 50x
  assert.ok(pre.plan.margin_pct <= 10);
  const r = await call('/order', order());
  assert.equal(r.ok, true, r.errors?.join());
  assert.equal(st.positions.length, 1);
  assert.equal(st.positions[0].stop, 99.7);
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
  const r = await call('/stop', { exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', stop: 99.5 });
  assert.match(r.error, /solo se puede mover a favor/);
  const ok = await call('/stop', { exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', stop: 99.8 });
  assert.equal(ok.ok, true);
});

test('guardian: si alejas el stop en la app del exchange, lo devuelve', async () => {
  st.positions[0].stop = 90;
  clock += 120000;
  await call('/guardian', {});
  assert.equal(st.positions[0].stop, 99.8);
  assert.deepEqual(st.calls.at(-1), ['stop', 99.8]);
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
  assert.equal(j.stop_price, 99.7);
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
});

test('historial: entran las operaciones hechas por fuera, sin duplicar las del terminal', async () => {
  const btc = DB.raw.prepare("SELECT * FROM exec_trades WHERE symbol='BTCUSDT' AND status='closed'").get();
  const row = (o) => ({ category: 'linear', entry_price: 100, exit_price: 101, size: 1, pnl: 1, fees: 0.1,
                        entry_time: btc.opened_at, exchange: 'bitget', ...o });
  st.history = [
    row({ symbol: 'BTCUSDT', side: 'long', exit_time: btc.closed_at + 30, exchange_id: 'p1' }),   // es la del terminal
    row({ symbol: 'ETHUSDT', side: 'short', exit_time: btc.closed_at, exchange_id: 'p2' }),        // hecha por fuera
  ];
  const r = await call('/history/sync', {});
  assert.equal(r.added, 1);
  const ext = DB.raw.prepare("SELECT * FROM trades WHERE exchange='bitget' AND exchange_id NOT LIKE 'tj:%'").all();
  assert.deepEqual(ext.map(t => t.symbol), ['ETHUSDT']);
  assert.equal(ext[0].exec_type, 'external');
  // la del terminal guarda la senal de entrada
  const j = DB.raw.prepare("SELECT signal FROM trades WHERE exchange_id = ?").get(`tj:${btc.id}`);
  assert.ok(j);
});

test('swing: Binance tiene sus propias reglas y no cuenta para el riesgo VWAP', async () => {
  clock = Date.UTC(2026, 10, 14, 15, 0);   // sabado: la estrategia VWAP no opera, el swing si
  DB.raw.exec('UPDATE risk_state SET lock_until = 0');
  await call('/accounts', { exchange: 'binance', key: 'k', secret: 's' });
  await call('/accounts/mode', { exchange: 'binance', dry_run: false });
  // posicion previa sin stop: se adopta como swing y el guardian le pone stop al 1%
  bn.st.positions = [{ exchange: 'binance', market: 'futures', symbol: 'ETHUSDT', side: 'long', size: 1, entry: 2000, mark: 2010, stop: null, stop_refs: [] }];
  bn.st.price = 2010;   // el simulado usa este precio como marca
  bn.st.calls.length = 0;
  clock += 60000;
  await call('/guardian', {});
  const adopted = DB.raw.prepare("SELECT * FROM exec_trades WHERE exchange='binance' AND symbol='ETHUSDT'").get();
  assert.equal(adopted.strategy, 'swing');
  const stops = bn.st.calls.filter(c => c[0] === 'stop').map(c => Math.round(c[1]));
  // capital swing = futuros 5000 + COIN-M 2000; riesgo 1% = 70 USD
  // ETH: 1 unidad -> stop 70 USD abajo. COIN-M BTC: 3 contratos de 100 USD = 0.005 BTC -> 14000 abajo
  assert.ok(stops.includes(1930), `stops: ${stops}`);
  assert.ok(stops.includes(46000), `stops: ${stops}`);
  const s = await call('/status?fresh=1');
  assert.ok(s.swing_positions.some(p => p.market === 'coinm'));
  assert.ok(!s.positions.some(p => p.exchange === 'binance'));
  assert.ok(s.equity.now < 2000, 'el capital VWAP no incluye Binance');
  assert.equal(s.swing_equity, 7000);
  // en la pestana VWAP no se puede usar Binance; en swing si, aunque sea sabado
  const wrong = await call('/preview', order({ exchange: 'binance' }));
  assert.match(wrong.error, /swing/);
  bn.st.positions = [];
  DB.raw.exec("DELETE FROM exec_trades WHERE exchange='binance'");
  bn.st.price = 100;
  const ok = await call('/preview', { strategy: 'swing', exchange: 'binance', market: 'futures', symbol: 'SOLUSDT', side: 'long',
    type: 'market', stop: 98, tp: 104, checklist: (await call('/status')).rules.swing.checklist });
  assert.equal(ok.ok, true, ok.errors?.join());
  assert.equal(ok.plan.leverage, 5);
  assert.ok(ok.plan.risk_usd <= 70 && ok.plan.risk_usd > 60);
});

test('swing: si el stop de una posicion heredada ya quedo cruzado, avisa y no cierra', async () => {
  bn.st.positions = [{ exchange: 'binance', market: 'futures', symbol: 'BTCUSDT', side: 'long', size: 1, entry: 60000, mark: 58000, stop: null, stop_refs: [] }];
  bn.st.price = 58000;
  bn.st.calls.length = 0;
  clock += 6 * 60000;   // fuera de la ventana y sin VWAP abierto, el guardian revisa cada 5 min
  await call('/guardian', {});
  assert.ok(!bn.st.calls.some(c => c[0] === 'close'));
  const ev = DB.raw.prepare("SELECT * FROM risk_events WHERE kind='guardian_alert' ORDER BY id DESC").get();
  assert.match(ev.message, /No se cierra solo/);
  bn.st.positions = [];
  DB.raw.exec("DELETE FROM exec_trades WHERE exchange='binance'");
  await call('/accounts/delete', { exchange: 'binance' });
});

test('guardian: fuera de la ventana y sin nada abierto revisa cada 5 min', async () => {
  clock = Date.UTC(2026, 10, 14, 18, 0);   // sabado, despues de la prueba anterior
  st.positions = [];
  assert.equal((await call('/guardian', {})).skipped, undefined);
  clock += 60000;
  assert.equal((await call('/guardian', {})).skipped, true);
  clock += 5 * 60000;
  assert.equal((await call('/guardian', {})).skipped, undefined);
  // con una posicion abierta vuelve a revisar cada minuto
  st.positions.push({ exchange: 'bitget', market: 'futures', symbol: 'BTCUSDT', side: 'long', size: 1, entry: 100, stop: 99.7, stop_refs: [] });
  clock += 6 * 60000;
  await call('/guardian', {});
  clock += 60000;
  assert.equal((await call('/guardian', {})).skipped, undefined);
  Date.now = realNow;
});
