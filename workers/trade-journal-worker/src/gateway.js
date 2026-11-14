// gateway.js — Durable Object que habla con los exchanges y aplica las reglas.
//
// Por que un Durable Object:
//  1. Ubicacion fija. Binance y Bitget bloquean IPs de EE. UU. (Binance responde
//     451) y un worker normal sale por el colo mas cercano a quien llama. El DO
//     se crea con locationHint (por defecto Europa occidental) y siempre sale
//     desde ahi, lo llame el cron o el navegador.
//  2. Una sola fila. Ordenes, cierres y el guardian pasan por una cola: dos
//     clics rapidos no pueden abrir dos operaciones saltandose el limite.

import {
  normalizeRules, splitChange, sessionWindow, newsStatus, parseCalendar, validateOrder,
  evaluateGates, lockFromGates, sizeOrder, chooseLeverage, guardianPlan, todayStats, nyParts,
  weekStart, addDays, rOf, CHANGE_DELAY_SEC, HARD, DEFAULT_RULES,
} from './risk.js';
import { snapshot, utcAnchor, nyOpenAnchor } from './indicators.js';
import { adapter, detectBitgetMode } from './exchanges/index.js';
import { seal, open as unseal } from './vault.js';
import { sleep, xfetch, useRelay } from './exchanges/common.js';

// Binance y Bitget rechazan las IPs de Cloudflare: las llamadas salen por Vercel
const RELAY_URL = 'https://kisushotto-site.vercel.app/api/exchange-relay';

const CAL_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CAL_TTL = 6 * 3600;
const CTX_TTL = 8000;

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const nowSec = () => Math.floor(Date.now() / 1000);
const nyDate = ms => nyParts(ms).date;
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

export class ExchangeGateway {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
    this.queue = Promise.resolve();
    this.ctxCache = null;
    // Inyectable para las pruebas (tests/gateway.test.js)
    this.adapter = env.ADAPTER || adapter;
    this.detectMode = env.DETECT_MODE || detectBitgetMode;
    if (env.JWT_SECRET && !env.ADAPTER && env.RELAY !== 'off') useRelay(env.RELAY_URL || RELAY_URL, env.JWT_SECRET);
  }

  // Serializa todo lo que cambia algo en el exchange o en el estado
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/exec/, '').replace(/\/$/, '') || '/';
    const m = req.method;
    const body = m === 'POST' ? await req.json().catch(() => ({})) : {};
    try {
      if (path === '/status'   && m === 'GET')  return json(await this.status(url.searchParams.get('fresh') === '1'));
      if (path === '/market'   && m === 'GET')  return json(await this.market(url.searchParams));
      if (path === '/events'   && m === 'GET')  return json(await this.events(+url.searchParams.get('limit') || 100));
      if (path === '/trades'   && m === 'GET')  return json(await this.trades());
      if (path === '/diag'     && m === 'GET')  return json(await this.diag());
      if (path === '/preview'  && m === 'POST') return json(await this.order(body, true));
      if (path === '/order'    && m === 'POST') return json(await this.serial(() => this.order(body, false)));
      if (path === '/stop'     && m === 'POST') return json(await this.serial(() => this.moveStop(body)));
      if (path === '/close'    && m === 'POST') return json(await this.serial(() => this.close(body)));
      if (path === '/cancel'   && m === 'POST') return json(await this.serial(() => this.cancelPending(body)));
      if (path === '/rules'    && m === 'POST') return json(await this.serial(() => this.setRules(body)));
      if (path === '/rules/cancel-pending' && m === 'POST') return json(await this.serial(() => this.cancelPendingRules()));
      if (path === '/lock'     && m === 'POST') return json(await this.serial(() => this.selfLock(body)));
      if (path === '/news/confirm' && m === 'POST') return json(await this.serial(() => this.confirmNews()));
      if (path === '/news/add' && m === 'POST') return json(await this.serial(() => this.addNews(body)));
      if (path === '/news/refresh' && m === 'POST') return json(await this.refreshCalendar(true));
      if (path === '/accounts' && m === 'POST') return json(await this.serial(() => this.saveAccount(body)));
      if (path === '/accounts/mode' && m === 'POST') return json(await this.serial(() => this.setMode(body)));
      if (path === '/accounts/delete' && m === 'POST') return json(await this.serial(() => this.deleteAccount(body)));
      if (path === '/guardian' && m === 'POST') return json(await this.serial(() => this.guardian()));
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      if (e.status !== 400) console.error(e.stack || e);
      return json({ error: e.message || 'Error interno' }, e.status === 400 ? 400 : 500);
    }
  }

  // ── Persistencia ───────────────────────────────────────────────────────────

  async log(kind, message, severity = 'info', data = null) {
    await this.db.prepare('INSERT INTO risk_events (ts, kind, severity, message, data) VALUES (?,?,?,?,?)')
      .bind(nowSec(), kind, severity, message, data ? JSON.stringify(data) : null).run();
  }

  // El guardian corre cada minuto: un mismo aviso no se repite en 30 min
  async logOnce(kind, message, severity, data = null) {
    const dup = await this.db.prepare('SELECT 1 FROM risk_events WHERE kind = ? AND message = ? AND ts > ? LIMIT 1')
      .bind(kind, message, nowSec() - 1800).first();
    if (!dup) await this.log(kind, message, severity, data);
  }

  async loadRules() {
    const row = await this.db.prepare('SELECT * FROM risk_rules WHERE id = ?').bind('main').first();
    let rules = normalizeRules(row ? JSON.parse(row.rules) : DEFAULT_RULES);
    let pending = row?.pending ? JSON.parse(row.pending) : null;
    let pendingAt = row?.pending_at || null;
    if (pending && pendingAt && pendingAt <= nowSec()) {
      rules = normalizeRules({ ...rules, ...pending }, rules);
      await this.saveRules(rules, null, null);
      await this.log('rules', `Entro en vigor el cambio de reglas: ${Object.keys(pending).join(', ')}`, 'warn', pending);
      pending = null; pendingAt = null;
    }
    if (!row) await this.saveRules(rules, null, null);
    return { rules, pending, pending_at: pendingAt };
  }

  async saveRules(rules, pending, pendingAt) {
    await this.db.prepare(`INSERT INTO risk_rules (id, rules, pending, pending_at, updated_at) VALUES ('main',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET rules=excluded.rules, pending=excluded.pending, pending_at=excluded.pending_at, updated_at=excluded.updated_at`)
      .bind(JSON.stringify(rules), pending ? JSON.stringify(pending) : null, pendingAt, nowSec()).run();
  }

  async loadState() {
    return (await this.db.prepare('SELECT * FROM risk_state WHERE id = ?').bind('main').first()) || { id: 'main' };
  }

  async patchState(patch) {
    const cols = Object.keys(patch);
    await this.db.prepare(`INSERT INTO risk_state (id, ${cols.join(',')}) VALUES ('main', ${cols.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${cols.map(c => `${c}=excluded.${c}`).join(',')}`)
      .bind(...cols.map(c => patch[c])).run();
  }

  async loadAccounts() {
    const { results } = await this.db.prepare('SELECT * FROM exec_accounts WHERE enabled = 1').all();
    const out = [];
    for (const r of results) {
      try {
        out.push({
          exchange: r.exchange, env: r.env, mode: r.mode, dry_run: !!r.dry_run,
          key: await unseal(r.api_key_enc, this.env.KEYS_SECRET),
          secret: await unseal(r.secret_enc, this.env.KEYS_SECRET),
          passphrase: await unseal(r.passphrase_enc, this.env.KEYS_SECRET),
        });
      } catch (e) {
        out.push({ exchange: r.exchange, broken: `No se pudieron descifrar las llaves: ${e.message}` });
      }
    }
    return out;
  }

  async loadLedger() {
    const since = nowSec() - 8 * 86400;
    const { results } = await this.db.prepare(
      "SELECT * FROM exec_trades WHERE opened_at >= ? OR status IN ('open','pending') ORDER BY opened_at"
    ).bind(since).all();
    return results;
  }

  async loadNews() {
    const [{ results }, meta] = await Promise.all([
      this.db.prepare('SELECT * FROM news_events WHERE date >= ? ORDER BY date, time').bind(addDays(nyDate(Date.now()), -1)).all(),
      this.db.prepare('SELECT * FROM news_meta WHERE id = ?').bind('ff').first(),
    ]);
    return { events: results, coverage: meta ? { from: meta.covered_from, to: meta.covered_to } : null, meta };
  }

  // ── Contexto: todo lo que hace falta para decidir ─────────────────────────

  async context(fresh = false) {
    if (!fresh && this.ctxCache && Date.now() - this.ctxCache.t < CTX_TTL) return this.ctxCache.ctx;
    const now = Date.now();
    const [r, state, accounts, ledger, news] = await Promise.all([
      this.loadRules(), this.loadState(), this.loadAccounts(), this.loadLedger(), this.loadNews(),
    ]);
    const { rules } = r;
    const win = sessionWindow(now, rules);
    const newsSt = newsStatus(win.date, news.events, news.coverage, state.news_confirmed_day === win.date);

    const reads = await Promise.allSettled(accounts.map(async acc => {
      if (acc.broken) throw new Error(acc.broken);
      const ex = this.adapter(acc);
      // Si falla solo spot (p. ej. la llave no tiene permiso de spot), los
      // futuros se siguen vigilando; el error igual bloquea ordenes nuevas.
      const [eq, pos, spot] = await Promise.all([ex.equity(), ex.futuresPositions(), ex.spotHoldings().catch(e => e)]);
      if (spot instanceof Error) {
        eq.errors = [...(eq.errors || []), `spot: ${spot.message}`];
        return { acc, eq, pos, spot: [], spotError: true };
      }
      return { acc, eq, pos, spot };
    }));
    const live = [], errors = [];
    reads.forEach((x, i) => {
      if (x.status === 'fulfilled') { live.push(x.value); for (const e of x.value.eq.errors || []) errors.push(`${accounts[i].exchange}: ${e}`); }
      else errors.push(`${accounts[i].exchange}: ${x.reason?.message || x.reason}`);
    });
    const positions = live.flatMap(x => x.pos);
    const spot = live.flatMap(x => x.spot);
    const readOk = accounts.length > 0 && errors.length === 0;
    const equityNow = readOk ? live.reduce((s, x) => s + x.eq.total, 0) : (state.equity_now || 0);

    // Capital al abrir el dia y la semana (NY). Solo se fija con una lectura completa.
    const patch = {};
    const wk = weekStart(win.date);
    if (readOk && equityNow > 0) {
      patch.equity_now = equityNow; patch.equity_at = nowSec();
      if (state.day !== win.date) { patch.day = win.date; patch.day_start_equity = equityNow; patch.news_confirmed_day = null; }
      if (state.week !== wk) { patch.week = wk; patch.week_start_equity = equityNow; }
    }
    if (Object.keys(patch).length) { await this.patchState(patch); Object.assign(state, patch); }

    const today = todayStats(ledger, win.date, nyDate);
    const lock = state.lock_until > nowSec() ? { until: state.lock_until, reason: state.lock_reason } : null;
    const key = x => `${x.exchange}|${x.market}|${x.symbol}|${x.side}`;
    const ledgerOpen = ledger.filter(t => t.status === 'open' || t.status === 'pending');
    const ledgerKeys = new Set(ledgerOpen.map(key));
    const base = Math.min(state.day_start_equity || equityNow, equityNow);
    // Lo abierto fuera del terminal tambien consume riesgo
    const external = positions.filter(p => !ledgerKeys.has(key(p))).map(p => ({
      symbol: p.symbol, side: p.side,
      risk_usd: p.stop ? Math.abs(p.entry - p.stop) * p.size : base * HARD.risk_pct.max / 100,
    }));
    const equity = { now: equityNow, day_start: state.day_start_equity, week_start: state.week_start_equity };
    const gateArgs = { now, rules, window: win, news: newsSt, lock, equity, today };
    const gates = evaluateGates({ ...gateArgs, open: [...ledgerOpen, ...external] });
    if (!readOk) gates.blocks.push({ code: 'read', msg: accounts.length ? `No se pudo leer: ${errors.join(' | ')}` : 'Conecta al menos una cuenta' }), gates.ok = false;
    // Para juzgar una posicion externa nueva no se cuenta ella misma
    const gatesLedger = evaluateGates({ ...gateArgs, open: ledgerOpen });

    if (readOk) {
      const newLock = lockFromGates(gates, rules, today);
      if (newLock && !lock) {
        const until = newLock.scope === 'week' ? endOfWeek(now) : endOfDay(now);
        await this.patchState({ lock_until: until, lock_reason: newLock.reason });
        await this.log('lock', `Bloqueado hasta ${new Date(until * 1000).toISOString()}: ${newLock.reason}`, 'critical');
        state.lock_until = until; state.lock_reason = newLock.reason;
        gates.blocks.unshift({ code: 'lock', msg: newLock.reason }); gates.ok = false;
      }
    }

    const ctx = { now, ...r, state, accounts, live, positions, spot, ledger, news: newsSt, newsList: news.events,
                  newsMeta: news.meta, window: win, today, gates, gatesLedger, errors, equity };
    this.ctxCache = { t: Date.now(), ctx };
    return ctx;
  }

  async status(fresh) {
    const ctx = await this.context(fresh);
    const accounts = (await this.db.prepare('SELECT exchange, env, mode, dry_run, enabled, last_error, updated_at FROM exec_accounts').all()).results;
    return {
      now: ctx.now, rules: ctx.rules, pending: ctx.pending, pending_at: ctx.pending_at, hard: HARD,
      window: ctx.window, news: ctx.news, news_list: ctx.newsList.slice(0, 20), news_meta: ctx.newsMeta,
      lock: ctx.state.lock_until > nowSec() ? { until: ctx.state.lock_until, reason: ctx.state.lock_reason } : null,
      equity: ctx.equity, today: ctx.today, gates: ctx.gates, errors: ctx.errors,
      accounts: accounts.map(a => ({ ...a, equity: ctx.live.find(l => l.acc.exchange === a.exchange)?.eq || null })),
      positions: ctx.positions.map(p => ({ ...p, trade: ctx.ledger.find(t => t.status === 'open' && t.exchange === p.exchange && t.market === 'futures' && t.symbol === p.symbol && t.side === p.side) || null })),
      spot: ctx.spot,
      open_trades: ctx.ledger.filter(t => t.status === 'open' || t.status === 'pending'),
      guardian_at: ctx.state.guardian_at, guardian_error: ctx.state.guardian_error,
      egress: ctx.state.egress ? JSON.parse(ctx.state.egress) : null,
      advice: afterHoursAdvice(ctx.window, ctx.positions),
    };
  }

  // ── Datos de mercado + indicadores ─────────────────────────────────────────

  async market(p) {
    const exchange = p.get('exchange') || 'binance';
    const market = p.get('market') === 'spot' ? 'spot' : 'futures';
    const symbol = String(p.get('symbol') || '').toUpperCase();
    const interval = ['1m', '3m', '5m', '15m'].includes(p.get('interval')) ? p.get('interval') : '5m';
    const anchor = p.get('anchor') === 'ny' ? 'ny' : 'utc';
    if (!symbol) throw bad('Falta el simbolo');
    const acc = (await this.loadAccounts()).find(a => a.exchange === exchange) || { exchange, key: '', secret: '' };
    const ex = this.adapter(acc);
    const mins = { '1m': 1, '3m': 3, '5m': 5, '15m': 15 }[interval];
    // Velas suficientes para cubrir desde el ancla mas 60 de calentamiento del RSI
    const sinceAnchor = anchor === 'utc' ? (Date.now() % 86400000) / 60000 : 24 * 60;
    const limit = Math.min(exchange === 'binance' && market === 'futures' ? 1500 : 1000, Math.ceil(sinceAnchor / mins) + 60);
    const [inst, candles] = await Promise.all([ex.instrument(market, symbol), ex.klines(market, symbol, interval, limit)]);
    const anchorOf = anchor === 'ny' ? nyOpenAnchor(nyParts) : utcAnchor;
    const snap = snapshot(candles, anchorOf);
    const lastAnchor = candles.length ? anchorOf(candles[candles.length - 1].t) : null;
    const partial = candles.length > 0 && anchorOf(candles[0].t) === lastAnchor && candles.length >= limit;
    return { exchange, market, symbol, interval, anchor, instrument: inst, indicators: snap, partial_vwap: partial };
  }

  // ── Orden ──────────────────────────────────────────────────────────────────

  async order(b, previewOnly) {
    const o = {
      exchange: b.exchange, market: b.market === 'spot' ? 'spot' : 'futures',
      symbol: String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
      side: b.side, type: b.type === 'limit' ? 'limit' : 'market',
      entry: +b.entry || null, stop: +b.stop, tp: +b.tp,
      checklist: Array.isArray(b.checklist) ? b.checklist : [],
      setup: b.setup || null, notes: b.notes || null, emotion: b.emotion || null, signal: b.signal || null,
    };
    if (o.market === 'spot' && o.type === 'limit') throw bad('En spot solo se admiten entradas a mercado (el stop se coloca al llenarse)');

    const ctx = await this.context(!previewOnly);
    const acc = ctx.accounts.find(a => a.exchange === o.exchange);
    if (!acc) throw bad(`No hay cuenta ${o.exchange} conectada`);
    const ex = this.adapter(acc);
    const [inst, px] = await Promise.all([ex.instrument(o.market, o.symbol), ex.price(o.market, o.symbol)]);
    const entry = o.type === 'market' ? px : o.entry;
    const errors = [];

    const v = validateOrder({ ...o, entry }, ctx.rules);
    errors.push(...v.errs);
    if (o.type === 'market' && o.stop > 0 && (o.side === 'long' ? px <= o.stop : px >= o.stop)) {
      errors.push('El precio actual ya esta del otro lado del stop');
    }
    errors.push(...ctx.gates.blocks.map(x => x.msg));
    const dup = ctx.positions.some(p => p.exchange === o.exchange && p.symbol === o.symbol) ||
                ctx.ledger.some(t => (t.status === 'open' || t.status === 'pending') && t.exchange === o.exchange && t.symbol === o.symbol);
    if (dup) errors.push(`Ya tienes una operacion en ${o.symbol}: no se promedia ni se piramida`);

    let size = null, lev = null;
    if (!v.errs.length && ctx.gates.risk_usd > 0) {
      // Tope de margen: max_margin_pct de la cuenta, apalancado. En spot no hay apalancamiento.
      const useLev = o.market === 'futures' ? Math.min(ctx.rules.leverage, inst.max_leverage || Infinity) : 1;
      const maxNotional = ctx.gates.base_equity * ctx.rules.max_margin_pct / 100 * useLev;
      size = sizeOrder({ risk_usd: ctx.gates.risk_usd, entry, stop: o.stop, step: inst.step,
                         min_qty: inst.min_qty, min_notional: inst.min_notional, fee_rate: inst.fee, max_notional: maxNotional });
      if (size.error) errors.push(size.error);
      else if (o.market === 'futures') {
        const accEq = ctx.live.find(l => l.acc.exchange === o.exchange)?.eq;
        lev = chooseLeverage({ notional: size.notional, available: accEq?.futures_available || 0,
          leverage: useLev, stop_dist_pct: size.stop_dist_pct });
        if (lev.error) errors.push(lev.error);
      } else {
        const usdt = ctx.spot.find(h => h.exchange === o.exchange && h.asset === 'USDT')?.free || 0;
        if (size.notional > usdt * 0.98) errors.push(`Saldo USDT en spot insuficiente (${usdt.toFixed(2)}) para ${size.notional.toFixed(2)}`);
      }
    }

    const plan = {
      ...o, entry, price: px, qty: size?.qty || 0, notional: size?.notional || 0,
      risk_usd: size?.risk_usd || 0, risk_pct: ctx.gates.base_equity ? (size?.risk_usd || 0) / ctx.gates.base_equity * 100 : 0,
      risk_budget_pct: ctx.gates.risk_pct, base_equity: ctx.gates.base_equity,
      leverage: lev?.leverage || (o.market === 'spot' ? 1 : null), liq_dist_pct: lev?.liq_dist_pct || null,
      margin: lev?.margin ?? (o.market === 'spot' ? size?.notional || 0 : 0),
      margin_pct: ctx.gates.base_equity ? (lev?.margin ?? (o.market === 'spot' ? size?.notional || 0 : 0)) / ctx.gates.base_equity * 100 : 0,
      capped_by_margin: !!size?.capped_by_margin,
      fees_round_trip: size?.qty ? (entry + o.tp) * inst.fee * size.qty : 0,
      rr: v.rr, fee: inst.fee, dry_run: acc.dry_run,
      loss_if_stop: size?.risk_usd || 0,
      gain_if_tp: size?.qty ? Math.abs(o.tp - entry) * size.qty - (entry + o.tp) * inst.fee * size.qty : 0,
    };
    if (previewOnly) return { ok: errors.length === 0, errors, plan };

    if (errors.length) {
      await this.log('rejected', `${o.side.toUpperCase()} ${o.symbol} rechazada: ${errors[0]}`, 'warn', { errors, plan });
      return { ok: false, errors, plan };
    }
    if (acc.dry_run) {
      await this.log('simulated', `Simulacion ${o.side.toUpperCase()} ${o.symbol} ${plan.qty} @ ${entry} riesgo ${plan.risk_usd.toFixed(2)} USDT`, 'info', plan);
      return { ok: true, simulated: true, plan };
    }
    return this.execute(ex, acc, o, plan, inst, ctx);
  }

  async execute(ex, acc, o, plan, inst, ctx) {
    const id = rid();
    const cid = `tj${id}`.slice(0, 30);
    const ins = this.db.prepare(`INSERT INTO exec_trades (id, exchange, market, symbol, side, order_type, status, qty, entry, stop, initial_stop, tp,
      risk_usd, risk_pct, equity_base, leverage, rr, checklist, setup, notes, emotion, signal, client_id, opened_at)
      VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Se registra antes de enviar: si el guardian corre en medio, ya la conoce
    await ins.bind(id, o.exchange, o.market, o.symbol, o.side, o.type, plan.qty, plan.entry, o.stop, o.stop, o.tp,
      plan.risk_usd, plan.risk_pct, plan.base_equity, plan.leverage, plan.rr, JSON.stringify(o.checklist), o.setup,
      o.notes, o.emotion, o.signal ? JSON.stringify(o.signal) : null, cid, nowSec()).run();
    const upd = (fields) => {
      const k = Object.keys(fields);
      return this.db.prepare(`UPDATE exec_trades SET ${k.map(c => `${c}=?`).join(',')} WHERE id=?`).bind(...k.map(c => fields[c]), id).run();
    };
    this.ctxCache = null;

    let res;
    try {
      res = o.market === 'futures'
        ? await ex.openFutures({ symbol: o.symbol, side: o.side, qty: plan.qty, type: o.type, price: o.entry, stop: o.stop, tp: o.tp,
                                 leverage: plan.leverage, cid, inst })
        : await ex.openSpot({ symbol: o.symbol, qty: plan.qty, stop: o.stop, tp: o.tp, cid, inst, ref_price: plan.price });
    } catch (e) {
      await upd({ status: 'rejected', error: e.message });
      await this.log('order_error', `${o.symbol}: el exchange rechazo la orden: ${e.message}`, 'error', { plan });
      return { ok: false, errors: [`Exchange: ${e.message}`], plan };
    }
    await upd({ order_id: res.order_id });

    if (o.market === 'spot') {
      if (!(res.filled_qty > 0)) { await upd({ status: 'cancelled', error: 'No se lleno' }); return { ok: false, errors: ['La compra no se lleno'], plan }; }
      const risk = Math.abs((res.avg_price || plan.entry) - o.stop) * res.filled_qty;
      await upd({ status: 'open', qty: res.filled_qty, entry: res.avg_price || plan.entry, risk_usd: risk });
      if (res.stop_error) {
        await ex.spotClose(o.symbol).catch(e => console.error(e));
        await upd({ status: 'closed', closed_at: nowSec(), close_reason: 'stop_failed', error: res.stop_error });
        await this.log('critical', `${o.symbol}: no se pudo poner el stop (${res.stop_error}). Se vendio de inmediato.`, 'critical');
        return { ok: false, errors: [`Stop fallido, posicion cerrada: ${res.stop_error}`], plan };
      }
      await this.log('order', `SPOT BUY ${o.symbol} ${res.filled_qty} @ ${res.avg_price} SL ${o.stop} TP ${o.tp} riesgo ${risk.toFixed(2)} USDT`, 'info', { id });
      return { ok: true, id, plan, result: res };
    }

    if (o.type === 'limit') {
      if (res.stop_error) await this.log('warn', `${o.symbol}: el stop se colocara al llenarse la limite (${res.stop_error})`, 'warn');
      await this.log('order', `LIMIT ${o.side.toUpperCase()} ${o.symbol} ${plan.qty} @ ${o.entry} SL ${o.stop} TP ${o.tp}`, 'info', { id });
      return { ok: true, id, plan, result: res };
    }

    // Mercado: verificar que la posicion existe y tiene stop. Si no se puede
    // proteger, se cierra. Nunca queda una posicion abierta sin stop.
    await sleep(700);
    let pos = null;
    for (let i = 0; i < 3 && !pos; i++) {
      pos = (await ex.futuresPositions().catch(() => [])).find(p => p.symbol === o.symbol && p.side === o.side);
      if (!pos) await sleep(700);
    }
    if (!pos) {
      await upd({ status: 'open' });
      await this.log('warn', `${o.symbol}: la orden se envio pero la posicion aun no aparece; el guardian la revisara`, 'warn');
      return { ok: true, id, plan, result: res, warning: 'Posicion aun no visible' };
    }
    if (!(pos.stop > 0)) {
      try { await ex.setStop(pos, o.stop); }
      catch (e) {
        await ex.closePosition(pos).catch(err => console.error(err));
        await upd({ status: 'closed', closed_at: nowSec(), close_reason: 'stop_failed', error: e.message });
        await this.log('critical', `${o.symbol}: no se pudo poner el stop (${e.message}). Posicion cerrada de inmediato.`, 'critical');
        return { ok: false, errors: [`Stop fallido, posicion cerrada: ${e.message}`], plan };
      }
    }
    const risk = Math.abs(pos.entry - o.stop) * pos.size;
    await upd({ status: 'open', qty: pos.size, entry: pos.entry, risk_usd: risk });
    await this.log('order', `${o.side.toUpperCase()} ${o.symbol} ${pos.size} @ ${pos.entry} SL ${o.stop} TP ${o.tp} ${plan.leverage}x riesgo ${risk.toFixed(2)} USDT (${(risk / plan.base_equity * 100).toFixed(2)}%)`, 'info', { id });
    return { ok: true, id, plan, result: { ...res, entry: pos.entry, qty: pos.size } };
  }

  // ── Gestion de posiciones: solo se puede reducir riesgo ───────────────────

  async findPos(b) {
    const acc = (await this.loadAccounts()).find(a => a.exchange === b.exchange);
    if (!acc) throw bad('Cuenta no conectada');
    const ex = this.adapter(acc);
    const pos = (await ex.futuresPositions()).find(p => p.symbol === b.symbol && p.side === b.side);
    return { acc, ex, pos };
  }

  async moveStop(b) {
    const { acc, ex, pos } = await this.findPos(b);
    if (!pos) throw bad('Posicion no encontrada');
    const stop = +b.stop;
    const long = pos.side === 'long';
    const cur = pos.stop;
    if (!(stop > 0)) throw bad('Stop invalido');
    if (cur && (long ? stop < cur : stop > cur)) {
      await this.log('rejected', `${pos.symbol}: intento de alejar el stop de ${cur} a ${stop}`, 'warn');
      throw bad('El stop solo se puede mover a favor (reducir riesgo), nunca alejarlo');
    }
    if (long ? stop >= pos.mark : stop <= pos.mark) throw bad('Ese stop ya esta del otro lado del precio: usa cerrar');
    if (acc.dry_run) return { ok: true, simulated: true };
    await ex.setStop(pos, stop);
    await this.db.prepare("UPDATE exec_trades SET stop = ? WHERE status = 'open' AND exchange = ? AND market = 'futures' AND symbol = ? AND side = ?")
      .bind(stop, pos.exchange, pos.symbol, pos.side).run();
    await this.log('stop', `${pos.symbol}: stop movido a ${stop}${cur ? ` (antes ${cur})` : ''}`);
    this.ctxCache = null;
    return { ok: true };
  }

  async close(b) {
    if (b.market === 'spot') {
      const acc = (await this.loadAccounts()).find(a => a.exchange === b.exchange);
      if (!acc) throw bad('Cuenta no conectada');
      if (acc.dry_run) return { ok: true, simulated: true };
      await this.adapter(acc).spotClose(String(b.symbol).toUpperCase());
      await this.log('close', `${b.symbol} spot: venta manual desde el terminal`);
      this.ctxCache = null;
      return { ok: true };
    }
    const { acc, ex, pos } = await this.findPos(b);
    if (!pos) throw bad('Posicion no encontrada');
    if (acc.dry_run) return { ok: true, simulated: true };
    const pct = Math.min(100, Math.max(1, +b.pct || 100));
    if (pct >= 100) await ex.closePosition(pos);
    else await ex.reduce(pos, pos.size * pct / 100);
    await this.log('close', `${pos.symbol}: cierre ${pct}% desde el terminal`);
    this.ctxCache = null;
    return { ok: true };
  }

  async cancelPending(b) {
    const t = await this.db.prepare("SELECT * FROM exec_trades WHERE id = ? AND status = 'pending'").bind(b.id).first();
    if (!t) throw bad('Orden pendiente no encontrada');
    const acc = (await this.loadAccounts()).find(a => a.exchange === t.exchange);
    await this.adapter(acc).cancelOrder(t.market, t.symbol, t.client_id);
    await this.db.prepare("UPDATE exec_trades SET status = 'cancelled', closed_at = ? WHERE id = ?").bind(nowSec(), t.id).run();
    await this.log('cancel', `${t.symbol}: limite cancelada`);
    this.ctxCache = null;
    return { ok: true };
  }

  // ── Reglas ─────────────────────────────────────────────────────────────────

  async setRules(input) {
    const { rules, pending } = await this.loadRules();
    const proposed = normalizeRules({ ...rules, ...input }, rules);
    const { tighter, looser } = splitChange(rules, proposed);
    const applied = normalizeRules({ ...rules, ...tighter }, rules);
    let nextPending = pending ? { ...pending } : null;
    for (const k of Object.keys(tighter)) if (nextPending) delete nextPending[k];
    let pendingAt = null;
    if (Object.keys(looser).length) {
      nextPending = { ...(nextPending || {}), ...looser };
      pendingAt = nowSec() + CHANGE_DELAY_SEC;
    } else if (nextPending && Object.keys(nextPending).length) {
      pendingAt = (await this.db.prepare('SELECT pending_at FROM risk_rules WHERE id = ?').bind('main').first())?.pending_at;
    } else nextPending = null;
    await this.saveRules(applied, nextPending, pendingAt);
    if (Object.keys(tighter).length) await this.log('rules', `Reglas endurecidas (aplican ya): ${Object.keys(tighter).join(', ')}`, 'info', tighter);
    if (Object.keys(looser).length) await this.log('rules', `Cambio que afloja reglas en espera 24h: ${Object.keys(looser).join(', ')}`, 'warn', looser);
    this.ctxCache = null;
    return { ok: true, applied: tighter, pending: nextPending, pending_at: pendingAt };
  }

  async cancelPendingRules() {
    const { rules } = await this.loadRules();
    await this.saveRules(rules, null, null);
    await this.log('rules', 'Cambio de reglas pendiente cancelado');
    return { ok: true };
  }

  async selfLock(b) {
    const until = endOfDay(Date.now());
    const reason = `Bloqueo voluntario${b.reason ? `: ${String(b.reason).slice(0, 200)}` : ''}`;
    const st = await this.loadState();
    if (st.lock_until > until) return { ok: true, until: st.lock_until };
    await this.patchState({ lock_until: until, lock_reason: reason });
    await this.log('lock', reason, 'warn');
    this.ctxCache = null;
    return { ok: true, until };
  }

  // ── Noticias ───────────────────────────────────────────────────────────────

  async refreshCalendar(force = false) {
    const meta = await this.db.prepare('SELECT * FROM news_meta WHERE id = ?').bind('ff').first();
    if (!force && meta?.fetched_at && nowSec() - meta.fetched_at < CAL_TTL && !meta.error) return { skipped: true };
    try {
      const res = await xfetch(CAL_URL, { headers: { 'User-Agent': 'trade-journal/1.0' } });
      if (!res.ok) throw new Error(`calendario ${res.status}`);
      const { events, coverage } = parseCalendar(await res.json());
      if (!coverage) throw new Error('calendario vacio');
      const stmt = this.db.prepare("INSERT OR IGNORE INTO news_events (date, title, time, source) VALUES (?,?,?,'ff')");
      const rows = events.map(e => stmt.bind(e.date, e.title, e.time));
      rows.push(this.db.prepare(`INSERT INTO news_meta (id, covered_from, covered_to, fetched_at, error) VALUES ('ff',?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET covered_from=excluded.covered_from, covered_to=excluded.covered_to, fetched_at=excluded.fetched_at, error=NULL`)
        .bind(coverage.from, coverage.to, nowSec()));
      await this.db.batch(rows);
      this.ctxCache = null;
      return { ok: true, events: events.length, coverage };
    } catch (e) {
      await this.db.prepare(`INSERT INTO news_meta (id, fetched_at, error) VALUES ('ff',?,?)
        ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at, error=excluded.error`).bind(nowSec(), e.message).run();
      return { ok: false, error: e.message };
    }
  }

  async confirmNews() {
    const ctx = await this.context(true);
    if (!ctx.news.unknown) throw bad('El calendario esta cargado: no hace falta confirmarlo');
    if (ctx.news.events.length) throw bad('Hoy hay noticias: no se opera');
    await this.patchState({ news_confirmed_day: ctx.window.date });
    await this.log('news', `Calendario no disponible: confirmaste a mano que ${ctx.window.date} no hay noticias de alto impacto`, 'warn');
    this.ctxCache = null;
    return { ok: true };
  }

  async addNews(b) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw bad('Fecha invalida (AAAA-MM-DD)');
    await this.db.prepare("INSERT OR IGNORE INTO news_events (date, title, time, source) VALUES (?,?,'','manual')")
      .bind(b.date, String(b.title || 'Noticia').slice(0, 120)).run();
    await this.log('news', `Dia de noticias agregado a mano: ${b.date} ${b.title || ''}`);
    this.ctxCache = null;
    return { ok: true };
  }

  // ── Cuentas ────────────────────────────────────────────────────────────────

  async saveAccount(b) {
    const exchange = b.exchange;
    if (!['binance', 'bitget'].includes(exchange)) throw bad('Exchange no soportado');
    if (!b.key || !b.secret) throw bad('Faltan API key y secret');
    if (exchange === 'bitget' && !b.passphrase) throw bad('Bitget necesita la passphrase de la API');
    const env = exchange === 'binance' && b.env === 'demo' ? 'demo' : 'live';
    const creds = { exchange, key: b.key.trim(), secret: b.secret.trim(), passphrase: b.passphrase?.trim(), env };
    if (exchange === 'bitget') creds.mode = await this.detectMode(creds);

    // Probar antes de guardar: una llave mala no debe quedar a medias
    const ex = this.adapter(creds);
    const eq = await ex.equity();
    await ex.futuresPositions();
    const S = this.env.KEYS_SECRET;
    const ts = nowSec();
    await this.db.prepare(`INSERT INTO exec_accounts (exchange, env, mode, api_key_enc, secret_enc, passphrase_enc, dry_run, enabled, created_at, updated_at)
      VALUES (?,?,?,?,?,?,1,1,?,?)
      ON CONFLICT(exchange) DO UPDATE SET env=excluded.env, mode=excluded.mode, api_key_enc=excluded.api_key_enc, secret_enc=excluded.secret_enc,
        passphrase_enc=excluded.passphrase_enc, dry_run=1, enabled=1, last_error=NULL, updated_at=excluded.updated_at`)
      .bind(exchange, env, creds.mode || null, await seal(creds.key, S), await seal(creds.secret, S), await seal(creds.passphrase, S), ts, ts).run();
    await this.log('account', `Cuenta ${exchange} conectada (${env}${creds.mode ? ', ' + creds.mode : ''}) en modo simulacion`, 'info');
    this.ctxCache = null;
    return { ok: true, equity: eq, mode: creds.mode || null };
  }

  async setMode(b) {
    const live = b.dry_run === false;
    if (live) {
      // Lo que ya estaba abierto al pasar a real se adopta en vez de cerrarse:
      // no es una entrada nueva fuera de regla. Igual queda obligado a tener
      // stop y a no pasar el riesgo maximo.
      const ctx = await this.context(true);
      const key = x => `${x.exchange}|${x.symbol}|${x.side}`;
      const known = new Set(ctx.ledger.filter(t => t.status === 'open' || t.status === 'pending').map(key));
      for (const p of ctx.positions.filter(p => p.exchange === b.exchange && !known.has(key(p)))) {
        await this.adopt(p, ctx);
        await this.log('guardian', `${p.symbol}: posicion previa al modo real adoptada; queda bajo las reglas de stop y riesgo`, 'warn');
      }
    }
    await this.db.prepare('UPDATE exec_accounts SET dry_run = ?, updated_at = ? WHERE exchange = ?').bind(live ? 0 : 1, nowSec(), b.exchange).run();
    await this.log('account', `${b.exchange}: ${live ? 'MODO REAL activado (envia ordenes y el guardian corrige)' : 'modo simulacion'}`, live ? 'warn' : 'info');
    this.ctxCache = null;
    return { ok: true };
  }

  async deleteAccount(b) {
    await this.db.prepare('DELETE FROM exec_accounts WHERE exchange = ?').bind(b.exchange).run();
    await this.log('account', `Cuenta ${b.exchange} eliminada`, 'warn');
    this.ctxCache = null;
    return { ok: true };
  }

  // ── Guardian ───────────────────────────────────────────────────────────────

  async guardian() {
    await this.refreshCalendar().catch(e => console.error('calendar', e));
    const ctx = await this.context(true);
    const acted = [];
    const g = ctx.gatesLedger;
    // Una posicion externa se juzga como si fuera una orden nueva del terminal
    const blocking = g.blocks;
    const tradingAllowed = { ok: blocking.length === 0, reason: blocking[0]?.msg };
    // Solo se juzgan las cuentas que se leyeron bien: si un exchange no
    // respondio, sus posiciones no "desaparecieron", simplemente no se ven.
    const readable = new Set(ctx.live.map(l => l.acc.exchange));

    const plan = guardianPlan({ positions: ctx.positions, ledger: ctx.ledger.filter(t => readable.has(t.exchange)), tradingAllowed, rules: ctx.rules,
                                baseEquity: ctx.gates.base_equity || ctx.equity.now, now: ctx.now });
    const accOf = ex => ctx.accounts.find(a => a.exchange === ex);

    for (const a of plan) {
      const exName = a.pos?.exchange || a.trade?.exchange;
      const acc = accOf(exName);
      if (!acc || acc.broken) continue;
      const ex = this.adapter(acc);
      const sym = a.pos?.symbol || a.trade?.symbol;
      try {
        if (a.type === 'adopt') {
          await this.adopt(a.pos, ctx);
          await this.log('guardian', `${sym}: ${a.reason}`, 'warn');
          acted.push(a.type);
          continue;
        }
        if (a.type === 'filled') {
          const risk = a.trade.stop ? Math.abs(a.pos.entry - a.trade.stop) * a.pos.size : null;
          await this.db.prepare("UPDATE exec_trades SET status='open', qty=?, entry=?, risk_usd=COALESCE(?, risk_usd) WHERE id=?")
            .bind(a.pos.size, a.pos.entry, risk, a.trade.id).run();
          await this.log('fill', `${sym}: la limite se lleno @ ${a.pos.entry}`);
          continue;
        }
        if (a.type === 'closed') { await this.settle(a.trade, ex); acted.push('closed'); continue; }
        if (a.type === 'check_pending') { await this.checkPending(a.trade, ex, a.cancel); continue; }

        // Acciones que tocan el exchange: en simulacion solo se avisan
        if (acc.dry_run) {
          await this.logOnce('guardian_sim', `[simulacion] ${sym}: ${a.reason} (accion: ${a.type})`, 'warn');
          continue;
        }
        if (a.type === 'set_stop') await ex.setStop(a.pos, a.stop);
        if (a.type === 'reduce')   await ex.reduce(a.pos, a.qty);
        if (a.type === 'close')    await ex.closePosition(a.pos);
        await this.log('guardian', `${sym}: ${a.reason}`, a.type === 'close' ? 'critical' : 'warn', { action: a.type, stop: a.stop, qty: a.qty });
        acted.push(a.type);
      } catch (e) {
        await this.logOnce('guardian_error', `${sym}: fallo ${a.type}: ${e.message}`, 'error');
      }
    }

    await this.guardSpot(ctx).catch(e => this.log('guardian_error', `spot: ${e.message}`, 'error'));

    // Fuera de la ventana las posiciones siguen abiertas con su stop, pero se
    // recomienda cerrarlas. El aviso se repite cada 30 min mientras sigan abiertas.
    const adv = afterHoursAdvice(ctx.window, ctx.positions);
    if (adv) await this.logOnce(adv.kind, adv.msg, 'warn');
    const patch = { guardian_at: nowSec(), guardian_error: ctx.errors.join(' | ') || null };
    if (!ctx.state.egress_at || nowSec() - ctx.state.egress_at > 1800) {
      patch.egress = JSON.stringify(await this.probeEgress().catch(e => ({ error: e.message })));
      patch.egress_at = nowSec();
    }
    await this.patchState(patch);
    this.ctxCache = null;
    return { ok: true, actions: plan.length, acted, errors: ctx.errors };
  }

  async adopt(p, ctx) {
    const risk = p.stop ? Math.abs(p.entry - p.stop) * p.size : null;
    await this.db.prepare(`INSERT INTO exec_trades (id, exchange, market, symbol, side, order_type, status, qty, entry, stop, initial_stop,
      risk_usd, risk_pct, equity_base, leverage, external, opened_at, notes)
      VALUES (?,?,?,?,?,'external','open',?,?,?,?,?,?,?,?,1,?,?)`)
      .bind(rid(), p.exchange, 'futures', p.symbol, p.side, p.size, p.entry, p.stop ?? null, p.stop ?? null, risk,
            risk && ctx.gates.base_equity ? risk / ctx.gates.base_equity * 100 : null, ctx.gates.base_equity,
            p.leverage ?? null, nowSec(), 'Abierta fuera del terminal').run();
  }

  async checkPending(t, ex, cancel) {
    const st = await ex.orderState(t.market, t.symbol, t.client_id).catch(() => null);
    if (!st) return;
    if (st.state === 'cancelled' && !(st.filled_qty > 0)) {
      await this.db.prepare("UPDATE exec_trades SET status='cancelled', closed_at=? WHERE id=?").bind(nowSec(), t.id).run();
      await this.log('cancel', `${t.symbol}: la limite ya no esta en el libro`);
    } else if (cancel && st.state === 'open') {
      await ex.cancelOrder(t.market, t.symbol, t.client_id);
      await this.db.prepare("UPDATE exec_trades SET status='cancelled', closed_at=? WHERE id=?").bind(nowSec(), t.id).run();
      await this.log('guardian', `${t.symbol}: limite cancelada porque ya no se puede operar (ventana/noticias/bloqueo)`, 'warn');
    }
  }

  // Cierra en el libro y en el journal una operacion que ya no esta en el exchange
  async settle(t, ex) {
    let res = null;
    try {
      res = t.market === 'futures'
        ? await ex.closedPnl(t.symbol, t.side, t.opened_at * 1000)
        : await ex.spotPnl(t.symbol, t.opened_at * 1000, (t.entry || 0) * (t.qty || 0));
    } catch (e) { console.error('pnl', e.message); }
    if (t.market === 'futures') await ex.cleanup(t.symbol);
    const pnl = res?.pnl ?? null;
    const r = rOf(pnl, t.risk_usd);
    const closedAt = res?.closed_at || nowSec();
    await this.db.prepare("UPDATE exec_trades SET status='closed', closed_at=?, exit_price=?, pnl=?, r=? WHERE id=?")
      .bind(closedAt, res?.exit_price ?? null, pnl, r, t.id).run();
    await this.toJournal({ ...t, closed_at: closedAt, exit_price: res?.exit_price ?? null, pnl, r });
    await this.log('closed', `${t.symbol} ${t.side} cerrada: ${pnl == null ? 'PnL pendiente' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`}${r != null ? ` (${r.toFixed(2)}R)` : ''}`,
      pnl != null && pnl < 0 ? 'warn' : 'info', { id: t.id });
  }

  async toJournal(t) {
    let checklist = [];
    try { checklist = JSON.parse(t.checklist || '[]'); } catch { /* vacio */ }
    const { rules } = await this.loadRules();
    const score = rules.checklist.length ? Math.round(checklist.filter(c => rules.checklist.includes(c)).length / rules.checklist.length * 10) : null;
    await this.db.prepare(`INSERT INTO trades (id, symbol, category, side, entry_price, exit_price, size, pnl, fees, entry_time, exit_time,
      strategy_tag, setup_tag, session, exec_type, notes, emotion, rule_score, stop_price, risk_usd, stop_source, status, exchange, exchange_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,'ny',?,?,?,?,?,?,'terminal','closed',?,?,?)
      ON CONFLICT(exchange, exchange_id) WHERE exchange_id IS NOT NULL DO UPDATE SET pnl=excluded.pnl, exit_price=excluded.exit_price, exit_time=excluded.exit_time`)
      .bind(crypto.randomUUID(), t.symbol, t.market === 'spot' ? 'spot' : 'linear', t.side, t.entry || 0, t.exit_price, t.qty || 0, t.pnl,
            t.opened_at, t.closed_at, t.external ? null : 'VWAP', t.setup, t.external ? 'external' : 'terminal', t.notes, t.emotion,
            t.external ? null : score, t.initial_stop, t.risk_usd, t.exchange, `tj:${t.id}`, nowSec()).run();
  }

  async guardSpot(ctx) {
    const readable = new Set(ctx.live.filter(l => !l.spotError).map(l => l.acc.exchange));
    for (const t of ctx.ledger.filter(x => x.market === 'spot' && x.status === 'open' && readable.has(x.exchange))) {
      const acc = ctx.accounts.find(a => a.exchange === t.exchange);
      if (!acc || acc.broken) continue;
      const ex = this.adapter(acc);
      const base = t.symbol.replace(/(USDT|USDC)$/, '');
      const held = ctx.spot.find(h => h.exchange === t.exchange && h.asset === base);
      if (!held || held.qty < (t.qty || 0) * 0.1) { await this.settle(t, ex); continue; }
      const stops = await ex.spotStopOrders(t.symbol);
      if (stops.length) continue;
      if (acc.dry_run) { await this.logOnce('guardian_sim', `[simulacion] ${t.symbol} spot sin stop`, 'warn'); continue; }
      const px = held.price;
      if (px <= t.stop) {
        await ex.spotClose(t.symbol);
        await this.log('guardian', `${t.symbol} spot: sin stop y bajo el nivel del stop: vendido`, 'critical');
      } else {
        await ex.spotPlaceStop(t.symbol, Math.min(held.free, t.qty), t.stop, t.tp);
        await this.log('guardian', `${t.symbol} spot: el stop desaparecio, se repone en ${t.stop}`, 'warn');
      }
    }
  }

  async events(limit) {
    const { results } = await this.db.prepare('SELECT * FROM risk_events ORDER BY id DESC LIMIT ?').bind(Math.min(limit, 500)).all();
    return { events: results };
  }

  async trades() {
    const { results } = await this.db.prepare('SELECT * FROM exec_trades ORDER BY opened_at DESC LIMIT 200').all();
    return { trades: results };
  }

  // Desde donde sale el trafico y si los exchanges responden (sin llaves).
  // Binance responde 451 desde ubicaciones restringidas.
  async probeEgress() {
    const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text()).catch(e => e.message);
    const info = Object.fromEntries(String(trace).split('\n').filter(Boolean).map(l => l.split('=')));
    const hit = url => xfetch(url).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 120) })).catch(e => ({ error: e.message }));
    const [bnF, bnS, bg] = await Promise.all([
      hit('https://fapi.binance.com/fapi/v1/time'), hit('https://api.binance.com/api/v3/time'), hit('https://api.bitget.com/api/v2/public/time'),
    ]);
    return { colo: info.colo, loc: info.loc, binance_futures: bnF, binance_spot: bnS, bitget: bg, keys_secret: !!this.env.KEYS_SECRET };
  }

  async diag() {
    const accounts = await this.loadAccounts();
    const checks = {};
    for (const a of accounts) {
      try { checks[a.exchange] = await this.adapter(a).diag(); } catch (e) { checks[a.exchange] = { error: e.message }; }
    }
    return { ...(await this.probeEgress()), accounts: checks };
  }
}

export function afterHoursAdvice(win, positions) {
  if (!positions.length) return null;
  const list = positions.map(p => `${p.symbol} ${p.side}`).join(', ');
  if (!win.in_window) {
    return { kind: 'after_hours', level: 'closed',
             msg: `Ventana cerrada con posicion abierta (${list}). Recomendacion: cierrala lo antes posible. El stop sigue obligatorio y el guardian lo vigila.` };
  }
  if (win.minutes_to_end != null && win.minutes_to_end <= 15) {
    return { kind: 'closing_soon', level: 'soon',
             msg: `La ventana cierra en menos de 15 min con posicion abierta (${list}). Recomendacion: sal antes del cierre o asegura el stop.` };
  }
  return null;
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

// Fin del dia NY (proxima medianoche), en segundos
function endOfDay(ms) {
  const { minutes } = nyParts(ms);
  return Math.floor(ms / 1000) + (1440 - minutes) * 60;
}

function endOfWeek(ms) {
  const { dow } = nyParts(ms);
  const days = (8 - dow) % 7 || 7;   // hasta el proximo lunes
  return endOfDay(ms) + (days - 1) * 86400;
}
