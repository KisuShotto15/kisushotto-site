// risk.js — motor de reglas. Todo aqui es puro (sin red ni base de datos) para
// poder probarlo: el gateway junta el contexto y estas funciones deciden.
//
// Principio: el servidor es el que dice si una orden sale o no. La UI solo
// muestra lo que el servidor va a decidir; nada del navegador es confiable.

// ── Limites duros ────────────────────────────────────────────────────────────
// No se pueden superar ni editando la configuracion: se recortan aqui.
export const HARD = {
  risk_pct:          { min: 0.1, max: 2 },    // riesgo por operacion, % de la cuenta
  max_open_risk_pct: { min: 0.1, max: 2 },    // riesgo total abierto a la vez
  daily_loss_pct:    { min: 0.5, max: 4 },
  weekly_loss_pct:   { min: 1,   max: 8 },
  max_trades_day:    { min: 1,   max: 6 },
  max_consec_losses: { min: 1,   max: 3 },
  cooldown_min:      { min: 15,  max: 240 },  // pausa obligatoria tras una perdida
  min_rr:            { min: 1,   max: 10 },
  leverage:          { min: 1,   max: 51 },   // apalancamiento fijo de la estrategia
  max_margin_pct:    { min: 1,   max: 10 },   // margen maximo por operacion, % de la cuenta
  max_positions:     { min: 1,   max: 3 },
  pre_open_min:      { min: 0,   max: 60 },   // ventana: 1h antes de la apertura como maximo
  post_close_min:    { min: 0,   max: 60 },   // ventana: 1h despues del cierre como maximo
};

// Hacia donde se afloja cada regla. 'up' = subir el numero es aflojar.
const LOOSER = {
  risk_pct: 'up', max_open_risk_pct: 'up', daily_loss_pct: 'up', weekly_loss_pct: 'up',
  max_trades_day: 'up', max_consec_losses: 'up', cooldown_min: 'down', min_rr: 'down',
  leverage: 'up', max_margin_pct: 'up', max_positions: 'up', pre_open_min: 'up', post_close_min: 'up',
};

export const DEFAULT_CHECKLIST = [
  'Dentro de la ventana y sin noticias macro hoy (lo valida el sistema)',
  'Precio en o mas alla de la 2da/3ra desviacion del VWAP',
  'RSI(6) en extremo a favor de la entrada (>80 para short, <20 para long)',
  'RSI estocastico cruzando desde la zona extrema',
  'Vela de confirmacion cerrada, no anticipo',
  'Objetivo realista: VWAP o la desviacion opuesta, con R:R minimo',
  'Estoy tranquilo: no es revancha, no es FOMO, no es aburrimiento',
];

export const DEFAULT_RULES = {
  risk_pct: 1,
  max_open_risk_pct: 2,
  daily_loss_pct: 3,
  weekly_loss_pct: 6,
  max_trades_day: 3,
  max_consec_losses: 2,
  cooldown_min: 30,
  min_rr: 1.5,
  leverage: 51,
  max_margin_pct: 10,
  max_positions: 2,
  pre_open_min: 60,
  post_close_min: 60,
  block_news: true,
  symbols: ['BTCUSDT'],        // la estrategia VWAP a 51x es solo para Bitcoin
  // Cuentas donde se opera la estrategia (reglas + guardian). El resto es swing:
  // solo lectura, sin reglas ni correcciones.
  vwap_exchanges: ['bitget'],
  checklist: DEFAULT_CHECKLIST,
};

export const CHANGE_DELAY_SEC = 24 * 3600;   // aflojar una regla tarda 24h en aplicar
export const MIN_RISK_FRACTION = 0.25;       // si el presupuesto deja menos de 1/4 del riesgo normal, no se opera

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

export function normalizeRules(input = {}, base = DEFAULT_RULES) {
  const out = { ...base };
  for (const k of Object.keys(HARD)) {
    const v = parseFloat(input[k]);
    if (Number.isFinite(v)) out[k] = clamp(v, HARD[k]);
    else out[k] = clamp(parseFloat(base[k] ?? DEFAULT_RULES[k]), HARD[k]);
  }
  for (const k of ['max_trades_day', 'max_consec_losses', 'cooldown_min', 'leverage',
                   'max_positions', 'pre_open_min', 'post_close_min']) {
    out[k] = Math.floor(out[k]);
  }
  delete out.max_leverage;   // regla vieja, reemplazada por leverage fijo
  // el riesgo por operacion nunca puede superar el riesgo total permitido
  out.risk_pct = Math.min(out.risk_pct, out.max_open_risk_pct);
  out.block_news = input.block_news === undefined ? base.block_news !== false : !!input.block_news;
  const syms = input.symbols ?? base.symbols ?? [];
  out.symbols = [...new Set((Array.isArray(syms) ? syms : String(syms).split(/[\s,;]+/))
    .map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  const vx = input.vwap_exchanges ?? base.vwap_exchanges ?? DEFAULT_RULES.vwap_exchanges;
  out.vwap_exchanges = [...new Set((Array.isArray(vx) ? vx : String(vx).split(/[\s,;]+/))
    .map(s => String(s).trim().toLowerCase()).filter(x => ['binance', 'bitget'].includes(x)))];
  const cl = input.checklist ?? base.checklist ?? DEFAULT_CHECKLIST;
  out.checklist = [...new Set((Array.isArray(cl) ? cl : []).map(s => String(s).trim()).filter(Boolean))].slice(0, 15);
  return out;
}

// Separa un cambio propuesto en lo que endurece (aplica ya) y lo que afloja
// (espera CHANGE_DELAY_SEC). Asi una decision tomada en caliente no tiene efecto.
export function splitChange(current, proposed) {
  const tighter = {}, looser = {};
  for (const k of Object.keys(LOOSER)) {
    if (proposed[k] === current[k]) continue;
    const up = proposed[k] > current[k];
    ((LOOSER[k] === 'up') === up ? looser : tighter)[k] = proposed[k];
  }
  if (proposed.block_news !== current.block_news) {
    (proposed.block_news ? tighter : looser).block_news = proposed.block_news;
  }
  const cur = new Set(current.symbols), nxt = new Set(proposed.symbols);
  if ([...cur].join() !== [...nxt].join()) {
    // permitir mas simbolos (o todos) es aflojar; quitar es endurecer
    const widens = (cur.size > 0 && nxt.size === 0) || [...nxt].some(s => cur.size > 0 && !cur.has(s));
    (widens ? looser : tighter).symbols = proposed.symbols;
  }
  const curVx = current.vwap_exchanges || [], nxtVx = proposed.vwap_exchanges || [];
  if ([...curVx].sort().join() !== [...nxtVx].sort().join()) {
    // sacar una cuenta de la estrategia la libera de las reglas: es aflojar
    (curVx.some(x => !nxtVx.includes(x)) ? looser : tighter).vwap_exchanges = nxtVx;
  }
  const curCl = current.checklist, nxtCl = proposed.checklist;
  if (curCl.join('\n') !== nxtCl.join('\n')) {
    const drops = curCl.some(c => !nxtCl.includes(c));
    (drops ? looser : tighter).checklist = nxtCl;
  }
  return { tighter, looser };
}

// ── Hora de Nueva York ───────────────────────────────────────────────────────

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(ms) {
  const p = Object.fromEntries(NY_FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(p.hour) * 60 + parseInt(p.minute),
    dow: DOW[p.weekday],
  };
}

// Lunes (fecha NY) de la semana que contiene `date`
export function weekStart(date) {
  const d = new Date(date + 'T12:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Feriados NYSE (mercado cerrado). Verificar cada anio en nyse.com/markets/hours-calendars.
export const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
// Cierre a las 13:00 NY
export const NYSE_EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

const OPEN_MIN = 9 * 60 + 30;

// Ventana operativa: desde pre_open_min antes de la apertura hasta
// post_close_min despues del cierre, solo en dias con sesion en NYSE.
export function sessionWindow(ms, rules) {
  const { date, minutes, dow } = nyParts(ms);
  const closeMin = NYSE_EARLY_CLOSE.has(date) ? 13 * 60 : 16 * 60;
  const start = OPEN_MIN - rules.pre_open_min;
  const end   = closeMin + rules.post_close_min;
  const hhmm  = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  let tradingDay = true, reason = null;
  if (dow === 0 || dow === 6) { tradingDay = false; reason = 'Fin de semana: no hay sesion en Wall Street'; }
  else if (NYSE_HOLIDAYS.has(date)) { tradingDay = false; reason = 'Feriado en NYSE: no hay sesion'; }

  const inWindow = tradingDay && minutes >= start && minutes < end;
  if (tradingDay && !inWindow) {
    reason = minutes < start
      ? `La ventana abre a las ${hhmm(start)} NY`
      : `La ventana cerro a las ${hhmm(end)} NY`;
  }
  return {
    date, minutes, trading_day: tradingDay, in_window: inWindow, reason,
    start: hhmm(start), end: hhmm(end), early_close: NYSE_EARLY_CLOSE.has(date),
    minutes_to_start: tradingDay && minutes < start ? start - minutes : null,
    minutes_to_end:   inWindow ? end - minutes : null,
  };
}

// ── Noticias macro ───────────────────────────────────────────────────────────
// events: [{date (NY), title, time, source}] de impacto alto para USD.
// coverage: {from, to} fechas NY que cubre el ultimo calendario descargado.
// Si el calendario no cubre el dia, no se sabe si hay noticias: se bloquea
// salvo que el usuario confirme que lo reviso a mano (queda registrado).
export function newsStatus(date, events, coverage, confirmedManual = false) {
  const today = events.filter(e => e.date === date);
  if (today.length) return { blocked: true, unknown: false, events: today, reason: `Dia de noticias: ${today.map(e => e.title).join(', ')}` };
  const covered = coverage?.from && coverage?.to && date >= coverage.from && date <= coverage.to;
  if (!covered && !confirmedManual) {
    return { blocked: true, unknown: true, events: [], reason: 'No hay calendario economico cargado para hoy. Revisalo y confirmalo a mano.' };
  }
  return { blocked: false, unknown: !covered, events: [], reason: null };
}

// Del JSON de Forex Factory se queda con lo de impacto alto en USD.
// La fecha viene con offset (2026-11-13T08:30:00-05:00): se pasa a fecha NY.
export function parseCalendar(list) {
  const events = [];
  let min = null;
  for (const e of Array.isArray(list) ? list : []) {
    const ms = Date.parse(e.date);
    if (!Number.isFinite(ms)) continue;
    const { date, minutes } = nyParts(ms);
    if (!min || date < min) min = date;
    if (e.country !== 'USD' || String(e.impact).toLowerCase() !== 'high') continue;
    events.push({ date, title: e.title, time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` });
  }
  if (!min) return { events, coverage: null };
  // La semana del feed va de domingo a sabado
  const d = new Date(min + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const from = d.toISOString().slice(0, 10);
  return { events, coverage: { from, to: addDays(from, 6) } };
}

// ── Validacion de la orden ───────────────────────────────────────────────────

export function validateOrder(o, rules) {
  const errs = [];
  const entry = +o.entry, stop = +o.stop, tp = +o.tp;
  if (!o.symbol) errs.push('Falta el simbolo');
  if (!['long', 'short'].includes(o.side)) errs.push('Lado invalido');
  if (o.market === 'spot' && o.side === 'short') errs.push('En spot solo se puede comprar (long)');
  if (!(entry > 0)) errs.push('Falta el precio de entrada');
  if (!(stop > 0)) errs.push('El stop loss es obligatorio');
  if (!(tp > 0)) errs.push('El take profit es obligatorio (se usa para medir el R:R)');
  if (errs.length) return { errs, rr: null };

  const long = o.side === 'long';
  if (long ? stop >= entry : stop <= entry) errs.push(`El stop debe quedar ${long ? 'por debajo' : 'por encima'} de la entrada`);
  if (long ? tp <= entry : tp >= entry) errs.push(`El take profit debe quedar ${long ? 'por encima' : 'por debajo'} de la entrada`);
  const rr = Math.abs(tp - entry) / Math.abs(entry - stop);
  if (Number.isFinite(rr) && rr < rules.min_rr) errs.push(`R:R ${rr.toFixed(2)} por debajo del minimo ${rules.min_rr}`);
  if (Math.abs(entry - stop) / entry < 0.0005) errs.push('Stop demasiado pegado a la entrada (<0.05%): el ruido lo saca');

  if (rules.symbols.length && !rules.symbols.includes(String(o.symbol).toUpperCase())) {
    errs.push(`${o.symbol} no esta en tu lista de simbolos permitidos`);
  }
  const checked = new Set(o.checklist || []);
  const missing = rules.checklist.filter(c => !checked.has(c));
  if (missing.length) errs.push(`Checklist incompleto: ${missing.length} punto(s) sin marcar`);
  return { errs, rr };
}

// ── Compuertas: se puede operar ahora? ───────────────────────────────────────
// ctx = { now, rules, window, news, lock, equity: {now, day_start, week_start},
//         open: [{symbol, side, risk_usd}], today: {trades, consec_losses, last_loss_at} }
// Devuelve los bloqueos y el riesgo que queda disponible para la siguiente operacion.
export function evaluateGates(ctx) {
  const { now, rules, window: win, news, lock, equity, open = [], today } = ctx;
  const blocks = [];
  const add = (code, msg) => blocks.push({ code, msg });

  if (lock && lock.until > now / 1000) add('lock', lock.reason || 'Bloqueado');
  if (!win.trading_day || !win.in_window) add('window', win.reason || 'Fuera de la ventana operativa');
  if (rules.block_news && news?.blocked) add(news.unknown ? 'news_unknown' : 'news', news.reason);
  if (today.trades >= rules.max_trades_day) add('max_trades', `Ya hiciste ${today.trades} de ${rules.max_trades_day} operaciones hoy`);
  if (today.consec_losses >= rules.max_consec_losses) add('consec', `${today.consec_losses} perdidas seguidas: se termino el dia`);
  if (today.last_loss_at && now / 1000 - today.last_loss_at < rules.cooldown_min * 60) {
    const left = Math.ceil((rules.cooldown_min * 60 - (now / 1000 - today.last_loss_at)) / 60);
    add('cooldown', `Pausa tras perdida: faltan ${left} min`);
  }
  if (open.length >= rules.max_positions) add('max_positions', `Ya tienes ${open.length} posicion(es) abierta(s), el maximo es ${rules.max_positions}`);

  // Base de riesgo: el menor entre el capital al iniciar el dia y el actual.
  // Ganar en la manana no agranda el riesgo de la tarde; perder si lo achica.
  const base = Math.min(equity.day_start || equity.now, equity.now);
  if (!(base > 0)) add('equity', 'No se pudo leer el capital de la cuenta');

  const dayPnlPct  = equity.day_start  ? (equity.now - equity.day_start)  / equity.day_start  * 100 : 0;
  const weekPnlPct = equity.week_start ? (equity.now - equity.week_start) / equity.week_start * 100 : 0;
  if (dayPnlPct  <= -rules.daily_loss_pct)  add('daily_loss',  `Perdida del dia ${dayPnlPct.toFixed(2)}%: limite ${rules.daily_loss_pct}% alcanzado`);
  if (weekPnlPct <= -rules.weekly_loss_pct) add('weekly_loss', `Perdida de la semana ${weekPnlPct.toFixed(2)}%: limite ${rules.weekly_loss_pct}% alcanzado`);

  // Presupuesto: si todos los stops abiertos y el nuevo saltan, no se puede
  // pasar ni el limite de riesgo abierto ni el de perdida diaria/semanal.
  const openRiskPct = base > 0 ? open.reduce((s, p) => s + (p.risk_usd || 0), 0) / base * 100 : 0;
  const budget = Math.min(
    rules.risk_pct,
    rules.max_open_risk_pct - openRiskPct,
    rules.daily_loss_pct + Math.min(0, dayPnlPct) - openRiskPct,
    rules.weekly_loss_pct + Math.min(0, weekPnlPct) - openRiskPct,
  );
  const riskPct = Math.max(0, Math.floor(budget * 100) / 100);
  if (riskPct < rules.risk_pct * MIN_RISK_FRACTION) {
    add('budget', `Sin presupuesto de riesgo: quedan ${riskPct.toFixed(2)}% (riesgo abierto ${openRiskPct.toFixed(2)}%)`);
  }

  return {
    ok: blocks.length === 0,
    blocks,
    base_equity: base,
    risk_pct: riskPct,
    risk_usd: base > 0 ? base * riskPct / 100 : 0,
    open_risk_pct: openRiskPct,
    day_pnl_pct: dayPnlPct,
    week_pnl_pct: weekPnlPct,
  };
}

// Bloqueos que, al aparecer, cierran el dia completo (no se levantan solos
// aunque luego cambie el numero, p. ej. si el equity rebota).
export function lockFromGates(gates, rules, today) {
  const hit = gates.blocks.find(b => ['daily_loss', 'weekly_loss', 'consec'].includes(b.code));
  if (!hit) return null;
  return { reason: hit.msg, scope: hit.code === 'weekly_loss' ? 'week' : 'day' };
}

// ── Tamano de la posicion ────────────────────────────────────────────────────

export function floorStep(v, step) {
  if (!(step > 0)) return v;
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return +(Math.floor(v / step + 1e-9) * step).toFixed(dec);
}

export function roundTick(v, tick) {
  if (!(tick > 0)) return v;
  const dec = Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));
  return +(Math.round(v / tick) * tick).toFixed(dec);
}

// El usuario no elige la cantidad: sale del riesgo y la distancia al stop.
// Se descuentan comisiones de entrada y salida y un margen de deslizamiento,
// asi que la perdida real si salta el stop queda por debajo del riesgo.
// max_notional: tope por margen (10% de la cuenta x apalancamiento). Con un stop
// amplio manda el riesgo; con uno muy corto manda el tope y se arriesga menos.
export function sizeOrder({ risk_usd, entry, stop, step, min_qty = 0, min_notional = 0, fee_rate = 0.0006, slippage = 0.0005, max_notional = Infinity }) {
  const perUnit = Math.abs(entry - stop) + (entry + stop) * fee_rate + stop * slippage;
  if (!(perUnit > 0) || !(risk_usd > 0)) return { qty: 0, error: 'Riesgo o stop invalido' };
  const byRisk = risk_usd / perUnit;
  const byMargin = max_notional / entry;
  const capped = byMargin < byRisk;
  const qty = floorStep(Math.min(byRisk, byMargin), step);
  const notional = qty * entry;
  if (!(qty > 0) || qty < min_qty) {
    return { qty: 0, error: `Con ${risk_usd.toFixed(2)} USDT de riesgo y ese stop la cantidad (${(risk_usd / perUnit).toPrecision(4)}) no llega al minimo del exchange (${min_qty}). Acerca el stop o no operes este setup.` };
  }
  if (notional < min_notional) {
    return { qty: 0, error: `Valor de la orden ${notional.toFixed(2)} por debajo del minimo ${min_notional} del exchange` };
  }
  return { qty, notional, risk_usd: qty * perUnit, stop_dist_pct: Math.abs(entry - stop) / entry * 100, capped_by_margin: capped };
}

// Apalancamiento fijo de la estrategia, margen aislado: si algo falla solo se
// pierde el margen de esa posicion. La liquidacion debe quedar mas lejos que el stop.
export function chooseLeverage({ notional, available, leverage, stop_dist_pct, mmr = 0.005 }) {
  if (!(available > 0)) return { error: 'Sin margen disponible en esa cuenta' };
  const lev = Math.max(1, Math.floor(leverage));
  const margin = notional / lev;
  if (margin > available * 0.95) {
    return { error: `El margen (${margin.toFixed(2)} USDT a ${lev}x) supera lo disponible en futuros (${available.toFixed(2)})` };
  }
  const liqDistPct = (1 / lev - mmr) * 100;
  if (stop_dist_pct >= liqDistPct * 0.8) {
    return { error: `Con ${lev}x la liquidacion (~${liqDistPct.toFixed(2)}%) queda muy cerca del stop (${stop_dist_pct.toFixed(2)}%)` };
  }
  return { leverage: lev, margin, liq_dist_pct: liqDistPct };
}

// ── Guardian ─────────────────────────────────────────────────────────────────
// Revisa lo que hay en el exchange contra lo que se aprobo. Corre cada minuto
// y tambien atrapa lo que se haga directo en la app del exchange.
// positions: [{exchange, market, symbol, side, size, entry, mark, stop}]
// ledger:    [{id, exchange, market, symbol, side, qty, stop, status, opened_at}]
// tradingAllowed: si ahora mismo se podria abrir (ventana, noticias, bloqueo).
export function guardianPlan({ positions, ledger, tradingAllowed, rules, baseEquity, now }) {
  const actions = [];
  const key = x => `${x.exchange}|${x.market}|${x.symbol}|${x.side}`;
  const open = new Map(ledger.filter(t => t.status === 'open' || t.status === 'pending').map(t => [key(t), t]));
  const seen = new Set();
  const capUsd = baseEquity * HARD.risk_pct.max / 100 * 1.15;   // 15% de holgura por redondeos y deslizamiento

  for (const p of positions) {
    if (p.market !== 'futures') continue;   // spot se revisa aparte (no hay posicion, hay saldo)
    const k = key(p);
    seen.add(k);
    const t = open.get(k);
    const long = p.side === 'long';
    const crossed = s => s > 0 && p.mark > 0 && (long ? p.mark <= s : p.mark >= s);

    if (!t) {
      if (rules.symbols.length && !rules.symbols.includes(p.symbol)) {
        actions.push({ type: 'close', pos: p, reason: `${p.symbol} no esta en tu estrategia (solo ${rules.symbols.join(', ')})` });
        continue;
      }
      if (!tradingAllowed.ok) {
        actions.push({ type: 'close', pos: p, reason: `Posicion abierta fuera del sistema mientras no se podia operar (${tradingAllowed.reason})` });
        continue;
      }
      actions.push({ type: 'adopt', pos: p, reason: 'Posicion abierta fuera del terminal: queda bajo las mismas reglas' });
    } else if (t.status === 'pending') {
      actions.push({ type: 'filled', pos: p, trade: t });
    }

    const want = t?.stop || null;
    if (!(p.stop > 0)) {
      const stop = want || emergencyStop(p, baseEquity * rules.risk_pct / 100);
      if (!stop || crossed(stop)) actions.push({ type: 'close', pos: p, reason: 'Sin stop y el precio ya paso el nivel de riesgo maximo' });
      else actions.push({ type: 'set_stop', pos: p, stop, reason: want ? 'El stop desaparecio: se repone' : 'Posicion sin stop: se coloca stop de emergencia al riesgo maximo' });
      continue;
    }
    if (want && (long ? p.stop < want * 0.9999 : p.stop > want * 1.0001)) {
      if (crossed(want)) actions.push({ type: 'close', pos: p, reason: 'Alejaste el stop y el precio ya cruzo el original: se cierra' });
      else actions.push({ type: 'set_stop', pos: p, stop: want, reason: 'Alejaste el stop: se devuelve a donde estaba' });
      continue;
    }
    if (t?.qty && p.size > t.qty * 1.01) {
      actions.push({ type: 'reduce', pos: p, qty: p.size - t.qty, reason: 'Agregaste tamano a la posicion: se recorta a lo aprobado' });
      continue;
    }
    const capNotional = baseEquity * rules.max_margin_pct / 100 * rules.leverage;
    if (p.size * p.entry > capNotional * 1.05) {
      actions.push({ type: 'reduce', pos: p, qty: p.size - capNotional / p.entry,
                     reason: `Posicion mayor al ${rules.max_margin_pct}% de margen a ${rules.leverage}x: se recorta` });
      continue;
    }
    const risk = Math.abs(p.entry - p.stop) * p.size;
    if (risk > capUsd) {
      const keep = capUsd / Math.abs(p.entry - p.stop);
      actions.push({ type: 'reduce', pos: p, qty: p.size - keep, reason: `Riesgo ${risk.toFixed(2)} USDT supera el 2% de la cuenta: se recorta` });
    }
  }

  for (const [k, t] of open) {
    if (t.market !== 'futures' || seen.has(k)) continue;
    // Una orden limite que aun no entra no tiene posicion: no es un cierre
    if (t.status === 'pending') { actions.push({ type: 'check_pending', trade: t, cancel: !tradingAllowed.ok }); continue; }
    if (now / 1000 - t.opened_at < 90) continue;   // margen para que el exchange refleje la posicion
    actions.push({ type: 'closed', trade: t });
  }
  return actions;
}

export function emergencyStop(p, riskUsd) {
  if (!(p.size > 0) || !(riskUsd > 0)) return null;
  const d = riskUsd / p.size;
  const s = p.side === 'long' ? p.entry - d : p.entry + d;
  return s > 0 ? s : null;
}

// Resultado en R de una operacion cerrada
export function rOf(pnl, riskUsd) {
  return riskUsd > 0 && pnl != null ? pnl / riskUsd : null;
}

// Una operacion cuenta como perdida si pierde mas de 0.2R (un scratch no rompe la racha)
export function isLoss(t) {
  const r = rOf(t.pnl, t.risk_usd);
  return r != null ? r < -0.2 : (t.pnl ?? 0) < 0;
}

// Estadisticas del dia a partir del libro de operaciones (ordenado por apertura)
export function todayStats(ledger, date, toNyDate) {
  const day = ledger.filter(t => t.status !== 'rejected' && t.status !== 'cancelled' && toNyDate(t.opened_at * 1000) === date);
  const closed = day.filter(t => t.status === 'closed').sort((a, b) => a.closed_at - b.closed_at);
  let consec = 0;
  for (let i = closed.length - 1; i >= 0 && isLoss(closed[i]); i--) consec++;
  const losses = closed.filter(isLoss);
  return {
    trades: day.length,
    consec_losses: consec,
    last_loss_at: losses.length ? losses[losses.length - 1].closed_at : null,
    pnl: closed.reduce((s, t) => s + (t.pnl || 0), 0),
    r: closed.reduce((s, t) => s + (rOf(t.pnl, t.risk_usd) || 0), 0),
  };
}
