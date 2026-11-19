// terminal.js — ticket de orden, estado de las reglas y posiciones.
// Toda la validacion real ocurre en el servidor; aqui solo se muestra.

import { exec } from './api.js';
import { LiveFeed } from './live-feed.js';
import { TicketChart } from './ticket-chart.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = v => (v >= 0 ? '+' : '') + fmt(v);
function px(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const n = +v;
  if (n >= 1000) return n.toFixed(1);
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function errMsg(e) {
  const m = String(e.message || e).match(/^API \d+: (.*)$/s);
  if (m) { try { return JSON.parse(m[1]).error || m[1]; } catch { return m[1]; } }
  return e.message || String(e);
}

function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 4500);
}

let S = null;          // ultimo /exec/status
// Estrategia de la pestana activa: 'vwap' (Bitget) o 'swing' (Binance)
let strat = (() => { try { return localStorage.getItem('tm_strat') === 'swing' ? 'swing' : 'vwap'; } catch { return 'vwap'; } })();
const isSwing = () => strat === 'swing';
const gatesOf = () => isSwing() ? S.swing_gates : S.gates;
const rulesOf = () => isSwing() ? S?.rules?.swing : S?.rules;
const positionsOf = () => (isSwing() ? S.swing_positions : S.positions) || [];

// value = lo que se guarda (igual que antes, para no romper la analitica); label = lo que se ve
const SETUPS = {
  vwap: [['VWAP 3σ reversion', 'Rebote en la banda 3'], ['VWAP 2σ reversion', 'Rebote en la banda 2'],
         ['Reversion a VWAP', 'Reversión a VWAP'], ['Rechazo en VWAP', 'Rechazo en el VWAP'], ['Ruptura y retest de banda', 'Ruptura y retest de banda']],
  swing: ['Retest de soporte / resistencia', 'Ruptura con volumen', 'Pullback en tendencia', 'Rango: extremo a extremo', 'Otro'].map(x => [x, x]),
};
let setupTouched = false;   // si el usuario eligio el setup a mano, no se cambia solo
window.renderSetupSum = () => {
  const o = $('tSetup').selectedOptions[0];
  $('setupSum').textContent = o ? o.textContent + (setupTouched ? '' : ' (detectado)') : '';
};
const MARKETS = {
  vwap: [['futures', 'Futuros USDT-M'], ['spot', 'Spot']],
  swing: [['futures', 'Futuros USDT-M'], ['coinm', 'Futuros COIN-M']],
};

window.setStrategy = s => {
  if (s === strat) return;
  strat = s;
  try { localStorage.setItem('tm_strat', s); } catch { /* sin storage */ }
  lastPreview = null;
  $('checklist').dataset.sig = '';
  applyStrategyUI();
  if (S) render();
  loadMarket();
};

function applyStrategyUI() {
  document.querySelectorAll('#stratTabs button').forEach(b => b.classList.toggle('active', b.dataset.s === strat));
  $('vwapStatus').classList.toggle('hidden', isSwing());
  $('swingStatus').classList.toggle('hidden', !isSwing());
  $('ticketTitle').textContent = `NUEVA OPERACION · ${isSwing() ? 'SWING' : 'VWAP'}`;
  $('titleStrat').textContent = isSwing() ? 'SWING' : 'VWAP';
  $('posTitle').textContent = `POSICIONES · ${isSwing() ? 'SWING' : 'VWAP'}`;
  $('tMarket').innerHTML = MARKETS[strat].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('tSetup').innerHTML = SETUPS[strat].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  setupTouched = false;
  renderSetupSum();
  manualChecks.clear();
  $('tType').disabled = false;
  document.querySelector('.tm-side.short').disabled = false;
  $('tSymbol').readOnly = false;
  if (isSwing() && !$('tSymbol').value) $('tSymbol').value = 'BTCUSDT';
}
let M = null;          // ultimo /exec/market
let side = 'long';
let lastPreview = null;
let previewTimer = null;

const RULE_LABELS = {
  risk_pct: 'Riesgo por operacion (%)', max_open_risk_pct: 'Riesgo abierto maximo (%)',
  daily_loss_pct: 'Perdida maxima diaria (%)', weekly_loss_pct: 'Perdida maxima semanal (%)',
  max_trades_day: 'Operaciones por dia', max_consec_losses: 'Perdidas seguidas que cierran el dia',
  cooldown_min: 'Pausa tras una perdida (min)', min_rr: 'R:R minimo', leverage: 'Apalancamiento (fijo, futuros)',
  max_margin_pct: 'Margen maximo por operacion (% cuenta)',
  max_positions: 'Posiciones simultaneas', pre_open_min: 'Minutos antes de la apertura NY',
  post_close_min: 'Minutos despues del cierre NY',
};

// ── Estado ────────────────────────────────────────────────────────────────────

async function loadStatus(fresh = false) {
  try {
    S = await exec.status(fresh);
    render();
  } catch (e) {
    $('verdictLabel').textContent = 'SIN CONEXION';
    $('verdictSub').textContent = errMsg(e);
    $('verdict').className = 'tm-verdict bad';
  }
}

function render() {
  const g = gatesOf();
  const v = $('verdict');
  if (g.ok) {
    v.className = 'tm-verdict ok';
    $('verdictLabel').textContent = 'PUEDES OPERAR';
    $('verdictSub').textContent = `Riesgo para la siguiente: ${fmt(g.risk_pct)}% · ${fmt(g.risk_usd)} USDT`;
  } else {
    v.className = 'tm-verdict bad';
    $('verdictLabel').textContent = 'NO SE OPERA';
    $('verdictSub').textContent = g.blocks[0]?.msg || '';
  }
  const blocks = $('blocks');
  blocks.classList.toggle('hidden', g.ok);
  blocks.innerHTML = g.blocks.map(b => `<div class="tm-block tm-block-${esc(b.code)}">${esc(b.msg)}</div>`).join('');

  // Con un solo simbolo permitido el ticket queda fijo en ese simbolo
  const syms = rulesOf().symbols;
  const only = syms.length === 1 ? syms[0] : null;
  if (only && $('tSymbol').value !== only) { $('tSymbol').value = only; loadMarket(); }
  $('tSymbol').readOnly = !!only;
  const adv = isSwing() ? null : S.advice;
  $('advice').classList.toggle('hidden', !adv);
  if (adv) {
    $('advice').className = `tm-advice ${adv.level}`;
    $('advice').innerHTML = `<div>${esc(adv.msg)}</div><div class="tm-row">${S.positions.map((p, i) =>
      `<button class="btn btn-sm btn-danger" onclick="posClose(${i}, 100)">Cerrar ${esc(p.symbol)} ${p.side.toUpperCase()}</button>`).join('')}</div>`;
  }
  renderWindow();
  renderNews();
  renderDay();
  renderSwingStatus();
  renderPositions();
  renderSpot();
  renderPending();
  renderChecklist();
  renderAccounts();
  renderRules();
  fillExchanges();
  const acc = S.accounts.find(a => a.exchange === $('tExchange').value);
  $('ticketMode').textContent = !acc ? 'sin cuenta · conectar' : acc.dry_run ? 'SIMULACION' : 'REAL';
  $('ticketMode').onclick = acc ? null : openAccounts;
  $('ticketMode').style.cursor = acc ? '' : 'pointer';
  $('ticketMode').className = `tm-mode ${acc && !acc.dry_run ? 'live' : ''}`;
  updateExecButton();
}

function renderWindow() {
  const w = S.window;
  $('winBig').textContent = `${w.start}–${w.end}`;
  $('winBig').className = `tm-big ${w.in_window ? 'pos' : 'neg'}`;
  $('winSub').textContent = w.in_window
    ? `Abierta · cierra en ${hm(w.minutes_to_end)}`
    : w.minutes_to_start != null ? `Abre en ${hm(w.minutes_to_start)}` : (w.reason || 'Cerrada');
}

const hm = m => m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;

function renderNews() {
  const n = S.news;
  if (n.events.length) {
    $('newsBig').textContent = 'NO SE OPERA';
    $('newsBig').className = 'tm-big neg';
    $('newsSub').textContent = n.events.map(e => `${e.time || ''} ${e.title}`.trim()).join(' · ');
  } else if (n.unknown && n.blocked) {
    $('newsBig').textContent = 'SIN DATOS';
    $('newsBig').className = 'tm-big warn';
    $('newsSub').textContent = 'El calendario no cubre hoy';
  } else {
    $('newsBig').textContent = 'LIBRE';
    $('newsBig').className = 'tm-big pos';
    $('newsSub').textContent = n.unknown ? 'Confirmado a mano' : 'Sin noticias que bloqueen el dia';
  }
  $('newsConfirm').classList.toggle('hidden', !(n.unknown && n.blocked && !n.events.length));

  $('newsList').innerHTML = S.news_list.length
    ? S.news_list.map(e => `<div class="tm-news-row ${e.major ? '' : 'minor'}"><b>${esc(e.date)}</b> <span>${esc(e.time)}</span> ${esc(e.title)} <i>${e.major ? 'bloquea el dia' : 'no bloquea'}</i></div>`).join('')
    : '<div class="tm-sub">Sin eventos proximos</div>';
  const meta = S.news_meta;
  if (meta) $('newsList').insertAdjacentHTML('beforeend', `<div class="tm-sub">Cobertura ${esc(meta.covered_from || '—')} a ${esc(meta.covered_to || '—')}${meta.error ? ` · error: ${esc(meta.error)}` : ''}</div>`);
}

function renderDay() {
  const g = S.gates, r = S.rules, t = S.today;
  const day = g.day_pnl_pct || 0;
  $('dayBig').textContent = `${day >= 0 ? '+' : ''}${fmt(day)}%`;
  $('dayBig').className = `tm-big ${day >= 0 ? 'pos' : 'neg'}`;
  meter('dayMeter', -day / r.daily_loss_pct);
  $('daySub').textContent = `${t.trades}/${r.max_trades_day} operaciones · racha ${t.consec_losses}/${r.max_consec_losses} · ${sign(t.r || 0)}R`;

  $('riskBig').textContent = `${fmt(g.risk_pct)}%`;
  $('riskBig').className = `tm-big ${g.ok ? 'acc' : 'neu'}`;
  $('riskSub').textContent = `${fmt(g.risk_usd)} USDT · base ${fmt(g.base_equity)} · abierto ${fmt(g.open_risk_pct)}%`;

  const wk = g.week_pnl_pct || 0;
  $('weekBig').textContent = `${wk >= 0 ? '+' : ''}${fmt(wk)}%`;
  $('weekBig').className = `tm-big ${wk >= 0 ? 'pos' : 'neg'}`;
  meter('weekMeter', -wk / r.weekly_loss_pct);
  $('weekSub').textContent = `limite ${r.weekly_loss_pct}% · capital ${fmt(S.equity.now)} USDT`;
}

function meter(id, frac) {
  const f = Math.max(0, Math.min(1, frac));
  $(id).style.width = `${Math.max(2, f * 100)}%`;
  $(id).className = `tm-meter-fill ${f >= 0.66 ? 'neg' : f >= 0.33 ? 'warn' : 'pos'}`;
}

// ── Posiciones ────────────────────────────────────────────────────────────────

function posRiskUsd(p) {
  // Riesgo actual: desde la entrada hasta el stop de ahora (no el inicial)
  if (!p.stop) return p.trade?.risk_usd || null;
  const base = p.market === 'coinm' && p.notional ? p.notional / p.entry : p.size;
  // Un stop del lado de la ganancia no arriesga nada
  return Math.max(0, p.side === 'long' ? p.entry - p.stop : p.stop - p.entry) * base;
}

function renderPositions() {
  syncChart();
  const list = positionsOf();
  $('posStamp').textContent = S.guardian_at ? `guardian hace ${Math.max(0, Math.round(Date.now() / 1000 - S.guardian_at))}s` : '';
  if (!list.length) { $('positions').innerHTML = '<div class="tm-sub">Sin posiciones abiertas</div>'; return; }
  $('positions').innerHTML = list.map((p, i) => {
    const risk = posRiskUsd(p);
    const coinm = p.market === 'coinm';
    // La R se mide contra el riesgo inicial de la operacion
    const r0 = p.trade?.risk_usd || risk;
    const rNow = r0 > 0 ? p.upnl / r0 : null;
    // "Stop a entrada" solo si acerca el stop: en ganancia y con el stop aun del lado de la perdida
    const be = (p.side === 'long' ? p.mark > p.entry : p.mark < p.entry) &&
               (!p.stop || (p.side === 'long' ? p.stop < p.entry : p.stop > p.entry));
    // Tarjeta: franja del lado, columnas fijas con etiqueta y resultado a la derecha
    const cell = (label, value, cls = '', note = '') => `<div class="pc-cell ${cls}"><span>${label}${note}</span><b>${value}</b></div>`;
    // Distancia del nivel al precio actual, junto a la etiqueta
    const distPct = v => v && p.mark ? ` <i>${((v / p.mark - 1) * 100 >= 0 ? '+' : '')}${fmt((v / p.mark - 1) * 100)}%</i>` : '';
    return `<div class="pc pc-${p.side}">
      <div class="pc-id">
        <b class="pc-sym">${esc(p.symbol)}</b>
        <span class="side-badge side-badge-${p.side}">${p.side.toUpperCase()}</span>
        <span class="tm-tag">${esc(p.exchange)}${coinm ? ' · COIN-M' : ''}</span>
        ${p.trade ? '' : '<span class="tm-tag warn">externa</span>'}
        ${p.leverage ? `<span class="tm-tag pc-lev">${p.leverage}x</span>` : ''}
      </div>
      <div class="pc-pnl ${p.upnl >= 0 ? 'pos' : 'neg'}">
        <b>${sign(p.upnl)}</b>
        <small>${rNow != null ? `${sign(rNow)}R` : 'USDT'}${coinm ? ` · ${p.upnl_coin >= 0 ? '+' : ''}${(+p.upnl_coin).toFixed(6)} ${esc(p.settle_coin)}` : ''}</small>
      </div>
      <div class="pc-grid">
        ${cell('TAMAÑO', coinm ? `${fmt(p.size, 0)} ct` : fmt(p.size, 4))}
        ${cell('ENTRADA', px(p.entry), 'c-entry')}
        ${cell('MARCA', px(p.mark))}
        ${p.stop ? cell('STOP', px(p.stop), 'c-sl', distPct(p.stop)) : cell('STOP', 'SIN SL', 'c-missing')}
        ${p.tp ? cell('TP', px(p.tp), 'c-tp', distPct(p.tp)) : ''}
        ${p.liq ? cell('LIQ', px(p.liq), 'c-liq', distPct(p.liq)) : ''}
        ${cell('RIESGO', risk > 0 ? `${fmt(risk)} USDT` : p.stop ? 'en ganancia' : '—', risk > 0 ? '' : p.stop ? 'c-tp' : '')}
      </div>
      <div class="pc-acts">
        ${be ? `<button onclick="posBreakeven(${i})">Stop a entrada</button>` : ''}
        <button onclick="posStop(${i})">Acercar stop</button>
        <button onclick="posClose(${i}, 50)">Cerrar 50%</button>
        <button class="danger" onclick="posClose(${i}, 100)">Cerrar</button>
      </div>
    </div>`;
  }).join('');
}

// Tarjetas de estado de la pestana swing
function renderSwingStatus() {
  if (!isSwing()) return;
  const g = S.swing_gates, r = S.rules.swing, list = S.swing_positions || [];
  $('swEq').textContent = `${fmt(S.swing_equity)} USD`;
  $('swRisk').textContent = `${fmt(g.risk_pct)}%`;
  $('swRisk').className = `tm-big ${g.ok ? 'acc' : 'neu'}`;
  $('swRiskSub').textContent = `${fmt(g.risk_usd)} USD por operacion · maximo ${r.risk_pct}%`;
  $('swOpen').textContent = `${fmt(g.open_risk_pct)}%`;
  meter('swOpenMeter', g.open_risk_pct / r.max_open_risk_pct);
  $('swOpenSub').textContent = `de ${r.max_open_risk_pct}% permitido · ${r.leverage}x aislado`;
  const noStop = list.filter(p => !p.stop).length;
  $('swCount').textContent = list.length;
  $('swCount').className = `tm-big ${noStop ? 'neg' : ''}`;
  $('swCountSub').textContent = noStop ? `${noStop} sin stop: el guardian se lo pone (en modo real)` : 'todas con stop';
}

function renderPending() {
  const pend = S.open_trades.filter(t => t.status === 'pending' && (t.strategy || 'vwap') === strat);
  $('pending').innerHTML = pend.length ? pend.map(t => `<div class="tm-pos">
      <div class="tm-pos-line"><b>${esc(t.symbol)}</b><span class="side-badge side-badge-${t.side}">${t.side.toUpperCase()}</span>
      <span class="tm-tag">${esc(t.exchange)}</span><span>${fmt(t.qty, 4)} @ ${px(t.entry)}</span>
      <button class="btn btn-sm btn-danger" onclick="cancelPending('${esc(t.id)}')">Cancelar</button></div>
      <div class="tm-pos-meta"><span class="lv lv-sl"><b>SL</b>${px(t.stop)}</span><span class="lv lv-tp"><b>TP</b>${px(t.tp)}</span><span>riesgo ${fmt(t.risk_usd)} USDT</span></div>
    </div>`).join('') : '';
  // Ordenes limite puestas directo en el exchange: solo se muestran, el terminal no las gestiona
  const ext = (S.open_orders || []).filter(o => !o.trade_id && o.profile === strat);
  $('pending').innerHTML += ext.map(o => `<div class="tm-pos">
      <div class="tm-pos-line"><b>${esc(o.symbol)}</b><span class="side-badge side-badge-${o.side}">${o.side.toUpperCase()}</span>
      <span class="tm-tag">${esc(o.exchange)}</span><span class="tm-tag warn">externa</span><span>${fmt(o.qty, 4)} @ ${px(o.price)}</span>
      <button class="btn btn-sm btn-danger" onclick="cancelExternal('${esc(o.exchange)}','${esc(o.order_id)}','${esc(o.symbol)}')">Cancelar</button></div>
      <div class="tm-pos-meta">${o.stop ? `<span class="lv lv-sl"><b>SL</b>${px(o.stop)}</span>` : '<span class="lv lv-missing">SIN SL</span>'}${o.tp ? `<span class="lv lv-tp"><b>TP</b>${px(o.tp)}</span>` : ''}${o.ts ? `<span>${new Date(o.ts * 1000).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>` : ''}</div>
    </div>`).join('');
  if (!pend.length && !ext.length) $('pending').innerHTML = '<div class="tm-sub">Sin ordenes limite pendientes</div>';
}

function renderSpot() {
  // Lo que vale menos de 1 USDT (polvo o sin precio) solo es ruido
  const rows = S.spot.filter(h => !h.stable && h.value >= 1).sort((a, b) => b.value - a.value);
  const stable = S.spot.filter(h => h.stable).reduce((s, h) => s + h.value, 0);
  $('spotTotal').textContent = `stables ${fmt(stable)} USDT`;
  const tradesBySym = new Map(S.open_trades.filter(t => t.market === 'spot').map(t => [`${t.exchange}|${t.symbol}`, t]));
  $('spot').innerHTML = rows.length ? rows.map(h => {
    const t = h.earn ? null : tradesBySym.get(`${h.exchange}|${h.symbol}`);
    return `<div class="tm-spot-row">
      <b>${esc(h.asset)}</b><span class="tm-tag">${esc(h.exchange)}</span>
      <span>${fmt(h.qty, 4)}</span><span>${fmt(h.value)} USDT</span>
      ${t ? `<span>SL ${px(t.stop)}</span>` : `<span class="tm-sub">${h.earn ? 'Earn' : 'fuera del terminal'}</span>`}
      ${t ? `<button class="btn btn-sm btn-danger" onclick="spotSell('${esc(h.exchange)}','${esc(h.symbol)}')">Vender</button>` : ''}
    </div>`;
  }).join('') : '<div class="tm-sub">Sin activos en spot</div>';
}

window.posBreakeven = i => moveStop(positionsOf()[i], positionsOf()[i].entry);
window.posStop = i => {
  const p = positionsOf()[i];
  const v = prompt(`Nuevo stop para ${p.symbol} (actual ${px(p.stop)}). Solo se puede acercar al precio.`, p.stop || '');
  if (v) moveStop(p, +v);
};
async function moveStop(p, stop) {
  try {
    const r = await exec.stop({ exchange: p.exchange, market: p.market, symbol: p.symbol, side: p.side, stop });
    toast(r.simulated ? 'Simulacion: el stop no se envio' : 'Stop actualizado');
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
}
window.posClose = async (i, pct) => {
  const p = positionsOf()[i];
  if (!confirm(`¿Cerrar ${pct}% de ${p.symbol} ${p.side.toUpperCase()} a mercado?`)) return;
  try {
    const r = await exec.close({ exchange: p.exchange, market: p.market || 'futures', symbol: p.symbol, side: p.side, pct });
    toast(r.simulated ? 'Simulacion: no se envio' : 'Orden de cierre enviada');
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
};
window.spotSell = async (exchange, symbol) => {
  if (!confirm(`¿Vender todo ${symbol} a mercado y cancelar su stop?`)) return;
  try { await exec.close({ exchange, market: 'spot', symbol }); toast('Venta enviada'); loadStatus(true); }
  catch (e) { toast(errMsg(e), 'err'); }
};
window.cancelExternal = async (exchange, order_id, symbol) => {
  if (!confirm(`¿Cancelar la orden limite de ${symbol} en ${exchange}?`)) return;
  try { await exec.cancel({ exchange, order_id }); toast('Orden cancelada'); loadStatus(true); }
  catch (e) { toast(errMsg(e), 'err'); }
};
window.cancelPending = async id => {
  try { await exec.cancel({ id }); toast('Orden cancelada'); loadStatus(true); }
  catch (e) { toast(errMsg(e), 'err'); }
};

// ── Ticket ────────────────────────────────────────────────────────────────────

function fillExchanges() {
  const sel = $('tExchange');
  const cur = sel.value;
  // Cada pestana solo opera las cuentas de su estrategia
  const mine = S.accounts.filter(a => a.profile === strat).map(a => a.exchange);
  const list = mine.length ? mine : isSwing() ? ['binance'] : S.rules.vwap_exchanges;
  const html = list.map(x => `<option value="${x}">${x === 'binance' ? 'Binance' : 'Bitget'}</option>`).join('');
  if (sel.innerHTML !== html) { sel.innerHTML = html; if (list.includes(cur)) sel.value = cur; }
}

// Puntos del checklist que el sistema puede comprobar con los indicadores en vivo.
// Solo avisan: si no se cumplen, el usuario igual puede marcarlos a mano.
const manualChecks = new Set();
function autoCheck(item) {
  if (isSwing()) return null;
  const t = item.toLowerCase(), I = M?.indicators, short = side === 'short';
  if (/ventana|noticia/.test(t)) {
    const ok = !!(S?.window?.in_window && !S?.news?.blocked);
    return { ok, note: ok ? 'sistema' : 'fuera de ventana o dia de noticias' };
  }
  if (!I) return /desviaci|rsi|estoc|objetivo|r:r/.test(t) ? { ok: false, note: 'sin datos' } : null;
  if (/objetivo|r:r/.test(t)) {
    const rr = lastPreview?.plan?.rr;
    return { ok: rr != null && rr >= rulesOf().min_rr, note: rr != null ? `${rr.toFixed(2)}R (min ${rulesOf().min_rr})` : 'pon SL y TP' };
  }
  if (/desviaci/.test(t)) return { ok: short ? I.sigma >= 2 : I.sigma <= -2, note: bandWords(I.sigma) };
  if (/rsi\s*\(?6/.test(t)) return { ok: I.rsi6 != null && (short ? I.rsi6 >= 80 : I.rsi6 <= 20), note: `RSI6 ${fmt(I.rsi6, 1)}` };
  if (/estoc/.test(t)) {
    const ok = I.stoch_cross === (short ? 'down' : 'up');
    return { ok, note: I.stoch_cross === 'up' ? 'cruce alcista' : I.stoch_cross === 'down' ? 'cruce bajista' : 'sin cruce' };
  }
  return null;
}
const checklistItems = () => (rulesOf()?.checklist || []).map(c => {
  const a = autoCheck(c);
  return { c, auto: a, checked: (a && a.ok) || manualChecks.has(c) };
});
const checkedList = () => checklistItems().filter(x => x.checked).map(x => x.c);
window.toggleCheck = i => {
  const c = rulesOf().checklist[i];
  if (manualChecks.has(c)) manualChecks.delete(c); else manualChecks.add(c);
  renderChecklist();
  updateExecButton();
};
// La vista previa va al servidor; el checklist se evalua aqui para no repetirla
// en cada cambio. Al enviar, el servidor lo vuelve a validar.
const isChecklistErr = e => /^Checklist incompleto/.test(e);
const otherErrors = () => (lastPreview?.errors || []).filter(e => !isChecklistErr(e));
const checklistDone = () => checklistItems().every(x => x.checked);
const canExecute = () => !!lastPreview?.plan && otherErrors().length === 0 && checklistDone();
function renderChecklist() {
  const items = checklistItems();
  const autos = items.filter(x => x.auto).length;
  $('ckSub').textContent = autos ? `· ${autos} automaticos (solo avisan) · ${items.length - autos} tuyos` : '· todos obligatorios';
  const html = items.map((x, i) => {
    if (x.auto) {
      const st = x.auto.ok ? 'ok' : manualChecks.has(x.c) ? 'hand' : 'no';
      return `<div class="tm-ck ${st}"><i>${st === 'no' ? '!' : '✓'}</i><span>${esc(x.c)}</span>
        ${x.auto.ok ? `<em>${esc(x.auto.note)}</em>`
          : `<em class="act" onclick="toggleCheck(${i})">${esc(x.auto.note)} · ${st === 'hand' ? 'quitar marca' : 'marcar a mano'}</em>`}</div>`;
    }
    return `<div class="tm-tg ${x.checked ? 'on' : ''}" onclick="toggleCheck(${i})"><i>${x.checked ? '✓' : ''}</i><span>${esc(x.c)}</span></div>`;
  });
  const autosHtml = html.filter((_, i) => items[i].auto).join('');
  const mineHtml = html.filter((_, i) => !items[i].auto).join('');
  const out = autosHtml + (autosHtml && mineHtml ? '<div class="tm-ck-sep"></div>' : '') + `<div class="tm-tgs">${mineHtml}</div>`;
  if ($('checklist').innerHTML !== out) $('checklist').innerHTML = out;
}

// "+2,41" desviaciones -> "entre la banda 2 y la 3 de arriba"
function bandWords(z) {
  if (z == null || !Number.isFinite(z)) return '—';
  const a = Math.abs(z), dir = z >= 0 ? 'arriba' : 'abajo';
  if (a < 0.15) return 'en el VWAP';
  if (a < 1) return `entre el VWAP y la banda 1 de ${dir}`;
  if (a >= 3) return `por fuera de la banda 3 de ${dir}`;
  const n = Math.floor(a);
  return `entre la banda ${n} y la ${n + 1} de ${dir}`;
}

// ── Entrada rapida: lado, SL y TP de un toque ────────────────────────────────
const QUICK = [
  { k: 'short3', side: 'short', band: 3, label: 'SHORT · banda 3 arriba', color: 'roja' },
  { k: 'short2', side: 'short', band: 2, label: 'SHORT · banda 2 arriba', color: 'amarilla' },
  { k: 'long2', side: 'long', band: 2, label: 'LONG · banda 2 abajo', color: 'amarilla' },
  { k: 'long3', side: 'long', band: 3, label: 'LONG · banda 3 abajo', color: 'roja' },
];
function renderQuick() {
  const box = $('quick');
  const I = M?.indicators;
  if (isSwing() || !I || $('tMarket').value !== 'futures') { box.innerHTML = ''; return; }
  const z = I.sigma;
  const now = z >= 3 ? 'short3' : z >= 2 ? 'short2' : z <= -3 ? 'long3' : z <= -2 ? 'long2' : null;
  const out = `<div class="tm-quick-head"><span>ENTRADA RAPIDA · TP en el VWAP</span><span>precio ${esc(bandWords(z))}</span></div>
    <div class="tm-quick-row">${QUICK.map(q => `<button class="tm-q ${q.side} ${q.k === now ? 'on' : now ? 'dim' : ''}" onclick="quickEntry('${q.k}')">
      <b>${q.side.toUpperCase()}</b><small>banda ${q.band} ${q.side === 'short' ? 'arriba' : 'abajo'} (${q.color})</small></button>`).join('')}</div>`;
  if (box.innerHTML !== out) box.innerHTML = out;
}
window.quickEntry = k => {
  const q = QUICK.find(x => x.k === k), I = M?.indicators;
  if (!q || !I) return;
  const sd = I.bands[0].up - I.vwap;
  const dir = q.side === 'short' ? 1 : -1;
  const band3 = q.side === 'short' ? I.bands[2].up : I.bands[2].dn;
  // SL un poco mas alla de la banda siguiente (desde la banda 3: una desviacion mas alla)
  let stop = band3 + dir * (q.band === 2 ? 0.15 : 1) * sd;
  // y nunca pegado al precio
  stop = q.side === 'short' ? Math.max(stop, I.price + 0.2 * sd) : Math.min(stop, I.price - 0.2 * sd);
  setSide(q.side);
  $('tType').value = 'market';
  $('tEntry').disabled = true;
  $('tStop').value = px(stop);
  $('tTp').value = px(I.vwap);
  if (!setupTouched) { $('tSetup').value = q.band === 3 ? 'VWAP 3σ reversion' : 'VWAP 2σ reversion'; renderSetupSum(); }
  schedulePreview();
};
window.setSide = s => {
  side = s;
  document.querySelectorAll('.tm-side').forEach(b => b.classList.toggle('active', b.dataset.side === s));
  schedulePreview();
};
window.onTypeChange = () => { $('tEntry').disabled = $('tType').value !== 'limit'; schedulePreview(); };
window.onMarketChange = () => {
  const spot = $('tMarket').value === 'spot';
  // COIN-M usa otros simbolos (BTCUSD_PERP); se traduce el del ticket
  const sym = $('tSymbol').value.trim().toUpperCase();
  if ($('tMarket').value === 'coinm' && /USDT$/.test(sym)) $('tSymbol').value = sym.replace(/USDT$/, 'USD_PERP');
  if ($('tMarket').value !== 'coinm' && /USD_PERP$/.test(sym)) $('tSymbol').value = sym.replace(/USD_PERP$/, 'USDT');
  if (spot) { setSide('long'); $('tType').value = 'market'; onTypeChange(); }
  document.querySelector('.tm-side.short').disabled = spot;
  $('tType').disabled = spot;
  loadMarket();
};

function currentOrder() {
  return {
    strategy: strat, exchange: $('tExchange').value, market: $('tMarket').value,
    symbol: $('tSymbol').value.trim().toUpperCase(), side, type: $('tType').value,
    entry: +$('tEntry').value || null, stop: +$('tStop').value || null, tp: +$('tTp').value || null,
    checklist: checkedList(),
    setup: $('tSetup').value, emotion: $('tEmotion').value || null, notes: $('tNotes').value.trim() || null,
    signal: M?.indicators ? {
      interval: M.interval, anchor: M.anchor, price: M.indicators.price, vwap: M.indicators.vwap,
      sigma: +M.indicators.sigma.toFixed(2), rsi6: M.indicators.rsi6 != null ? +M.indicators.rsi6.toFixed(1) : null,
      stoch_k: M.indicators.stoch_k != null ? +M.indicators.stoch_k.toFixed(1) : null,
      stoch_d: M.indicators.stoch_d != null ? +M.indicators.stoch_d.toFixed(1) : null, stoch_cross: M.indicators.stoch_cross,
    } : null,
  };
}

window.schedulePreview = () => {
  syncChart();
  renderChecklist();
  renderQuick();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(preview, 350);
};

async function preview() {
  const o = currentOrder();
  if (!o.stop || !o.tp || !o.symbol) {
    lastPreview = null;
    $('preview').innerHTML = '<div class="tm-sub">Pon stop y objetivo para ver el tamano</div>';
    updateExecButton();
    return;
  }
  try {
    lastPreview = await exec.preview(o);
    renderPreview(lastPreview);
    renderChecklist();
    chart.place();
  } catch (e) {
    lastPreview = null;
    $('preview').innerHTML = `<div class="tm-err">${esc(errMsg(e))}</div>`;
  }
  updateExecButton();
}

function renderPreview(r) {
  const p = r.plan;
  $('preview').innerHTML = `
    <div class="tm-prev-grid">
      <div><span>Cantidad</span><b>${p.market === 'coinm' ? `${p.qty} contratos` : fmt(p.qty, 4)}</b></div>
      <div><span>Valor</span><b>${fmt(p.notional)} ${p.market === 'coinm' ? 'USD' : 'USDT'}</b></div>
      <div><span>Apalancamiento</span><b>${p.leverage ? p.leverage + 'x aislado' : '—'}</b></div>
      <div><span>Margen</span><b>${fmt(p.margin)} USDT · ${fmt(p.margin_pct)}%</b></div>
      <div><span>Comisiones ida y vuelta</span><b>${fmt(p.fees_round_trip)} USDT</b></div>
      <div><span>Liquidacion aprox.</span><b style="color:var(--lv-liq)">${p.liq_dist_pct ? fmt(p.liq_dist_pct) + '% de la entrada' : '—'}</b></div>
      <div><span>R:R</span><b>${p.rr ? p.rr.toFixed(2) : '—'}</b></div>
      <div><span>Si salta el stop</span><b class="neg">-${fmt(p.loss_if_stop)} USDT · ${fmt(p.risk_pct)}%</b></div>
      <div><span>Si llega al objetivo</span><b class="pos">+${fmt(p.gain_if_tp)} USDT</b></div>
    </div>
    <div class="tm-sub">Precio ${px(p.price)} · entrada ${px(p.entry)} · comision ${(p.fee * 100).toFixed(3)}% incluida en el tamano</div>
    ${p.capped_by_margin ? `<div class="tm-sub warn">Tamano limitado por el margen maximo (${S.rules.max_margin_pct}% a ${p.leverage}x): arriesgas menos que tu presupuesto.</div>` : ''}
    ${p.market === 'coinm' ? `<div class="tm-sub">COIN-M: ${p.contract_size} USD por contrato; margen y resultado en la moneda base.</div>` : ''}
    ${otherErrors().length ? `<ul class="tm-errs">${otherErrors().map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="tm-ok">Cumple las reglas de riesgo</div>'}`;
}

let armTimer = null;
function updateExecButton() {
  const b = $('execBtn');
  if (armTimer) return;   // esperando el segundo toque
  const ok = canExecute();
  b.disabled = !ok;
  const acc = S?.accounts.find(a => a.exchange === $('tExchange').value);
  b.innerHTML = ok
    ? `${acc?.dry_run ? 'SIMULAR' : side.toUpperCase()} ${esc($('tSymbol').value.trim().toUpperCase())} · arriesgar ${fmt(lastPreview.plan.loss_if_stop)} USDT<small>toca para preparar</small>`
    : !lastPreview?.plan ? 'Pon SL y TP' : otherErrors().length ? 'Bloqueado por las reglas de riesgo' : 'Completa el checklist';
  b.className = `tm-exec ${ok ? side : ''}`;
}

// Primer toque: prepara. Segundo toque en menos de 3 s: envia. Sin ventana aparte.
window.execute = () => {
  if (!canExecute()) return;
  const b = $('execBtn');
  if (armTimer) { clearTimeout(armTimer); armTimer = null; return sendOrder(); }
  const p = lastPreview.plan;
  b.className = `tm-exec ${side} arm`;
  b.innerHTML = `CONFIRMAR ${side.toUpperCase()} · toca otra vez<small>${p.type === 'limit' ? 'limite ' + px(p.entry) : 'a mercado'} · ${fmt(p.qty, 4)} · pierdes ${fmt(p.loss_if_stop)} USDT (${fmt(p.risk_pct)}%) si salta el stop${p.dry_run ? ' · SIMULACION' : ''}</small><span class="tm-exec-bar"></span>`;
  armTimer = setTimeout(() => { armTimer = null; updateExecButton(); }, 3000);
};

async function sendOrder() {
  const btn = $('execBtn');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const r = await exec.order(currentOrder());
    if (r.ok) {
      toast(r.simulated ? 'Simulacion registrada en la bitacora' : 'Orden enviada con stop');
      if (!r.simulated) {
        manualChecks.clear();
        $('tNotes').value = '';
      }
    } else toast(r.errors?.[0] || 'Rechazada', 'err');
    await loadStatus(true);
    loadEvents();
    await preview();
  } catch (e) { toast(errMsg(e), 'err'); }
  updateExecButton();
}

// ── Mercado e indicadores ─────────────────────────────────────────────────────

window.loadMarket = async () => {
  const symbol = $('tSymbol').value.trim().toUpperCase();
  if (!symbol) return;
  $('indStamp').textContent = 'cargando…';
  try {
    // VWAP: el grafico y los indicadores salen siempre del perpetuo de Binance (el de
    // mas volumen), aunque la orden vaya a Bitget. Swing: el del exchange elegido.
    const src = chartSource();
    M = await exec.market({ exchange: src.exchange, market: src.market, symbol,
                            interval: $('tInterval').value, anchor: $('tAnchor').value });
    $('tcSrc').textContent = `${src.exchange === 'binance' ? 'Binance' : 'Bitget'} · ${symbol}${src.market === 'futures' ? '.P' : src.market === 'coinm' ? ' COIN-M' : ' spot'}`;
    renderIndicators();
    chart.setData(M.candles.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), M.anchor, M.instrument?.tick);
    syncChart();
    // Desde aqui los indicadores se actualizan por WebSocket, sin mas peticiones
    if (M.candles?.length) feed.start(M);
  } catch (e) {
    M = null;
    feed.stop();
    $('bands').innerHTML = `<div class="tm-err">${esc(errMsg(e))}</div>`;
    $('osc').innerHTML = '';
    $('indStamp').textContent = '';
  }
  schedulePreview();
};

let feedState = 'off';
const feed = new LiveFeed({
  onUpdate: snap => {
    if (!M) return;
    M.indicators = snap;
    renderIndicators();
    chart.update(feed.candles);
    if ($('tType').value !== 'limit') syncChart();
  },
  onStatus: st => { feedState = st; if (M?.indicators) renderStamp(); },
});

function renderStamp() {
  const label = { live: '● en vivo', connecting: 'conectando…', reconnecting: 'reconectando…', off: 'sin tiempo real' }[feedState] || '';
  $('indStamp').innerHTML = `<span class="tm-feed ${feedState}">${label}</span> ${new Date(M.indicators.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}${M.partial_vwap ? ' · VWAP parcial' : ''}`;
}

function renderIndicators() {
  const s = M.indicators;
  if (!s) { $('bands').innerHTML = '<div class="tm-sub">Sin velas</div>'; return; }
  renderStamp();
  // Los niveles de las bandas se ven en el grafico; aqui no se repiten
  $('bands').innerHTML = '';
  renderQuick();
  renderChecklist();
  updateExecButton();
  const rsiCls = s.rsi6 >= 80 ? 'neg' : s.rsi6 <= 20 ? 'pos' : '';
  const stCls = s.stoch_k >= 80 ? 'neg' : s.stoch_k <= 20 ? 'pos' : '';
  $('osc').innerHTML = `
    <div><span>RSI 6</span><b class="${rsiCls}">${fmt(s.rsi6, 1)}</b></div>
    <div><span>Estoc. RSI K/D</span><b class="${stCls}">${fmt(s.stoch_k, 1)} / ${fmt(s.stoch_d, 1)}</b></div>
    <div><span>Cruce</span><b>${s.stoch_cross === 'up' ? '↑ alcista' : s.stoch_cross === 'down' ? '↓ bajista' : '—'}</b></div>`;
}

// Contexto del ticket en una linea (exchange, mercado, simbolo, apalancamiento)
function renderCtx() {
  const lev = isSwing() ? S?.rules?.swing?.leverage : S?.rules?.leverage;
  const mk = $('tMarket').selectedOptions[0]?.textContent || '';
  $('ctxSum').innerHTML = [$('tExchange').selectedOptions[0]?.textContent || $('tExchange').value, $('tSymbol').value.toUpperCase(), mk]
    .filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('') +
    (lev && $('tMarket').value !== 'spot' ? `<span class="chip lev">${lev}x</span>` : '');
}

// ── Grafico con SL / TP / limite arrastrables ─────────────────────────────────

const LEVEL_INPUT = { sl: 'tStop', tp: 'tTp', entry: 'tEntry' };
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const refPrice = () => ($('tType').value === 'limit' && +$('tEntry').value) || M?.indicators?.price || chart.lastPrice();

function levelLabel(name, price) {
  const ref = refPrice();
  const d = ref ? (price / ref - 1) * 100 : 0;
  const plan = lastPreview?.plan;
  if (name === 'entry') {
    // Etiqueta de la orden: lado, SL y TP para arrastrar, cantidad y precio.
    // Limite: el precio se arrastra y la × la pasa a mercado. Mercado: sigue al precio.
    const limit = $('tType').value === 'limit';
    const qty = plan && plan.type === (limit ? 'limit' : 'market') ? fmt(plan.qty, 4) : '—';
    return `<span class="p-side ${side}">${side === 'long' ? 'Compra' : 'Venta'}</span>` +
      `<span class="p-btn tp" data-act="add-tp" title="Arrastra para poner el TP">TP</span>` +
      `<span class="p-btn sl" data-act="add-sl" title="Arrastra para poner el SL">SL</span>` +
      `<span class="p-qty">${qty}</span>` +
      (limit ? `<span class="p-px"><span class="hm">Limite </span>${px(price)}</span><span class="p-x" data-act="remove" title="Pasar a orden a mercado">×</span>`
             : '<span class="p-px">Mercado</span>');
  }
  if (name === 'sl') {
    const loss = plan && Math.abs(plan.stop - price) < 1e-9 ? `<span class="hm"> · −${fmt(plan.loss_if_stop)} USDT</span>` : '';
    return `SL ${px(price)} · ${pct(d)}${loss}<span class="h-x" data-act="remove" title="Quitar el SL">×</span>`;
  }
  const stop = +$('tStop').value;
  const rr = ref && stop && Math.abs(ref - stop) > 0 ? Math.abs(price - ref) / Math.abs(ref - stop) : null;
  const gain = plan && Math.abs(plan.tp - price) < 1e-9 ? `<span class="hm"> · +${fmt(plan.gain_if_tp)} USDT</span>` : '';
  return `TP ${px(price)} · ${rr ? `${rr.toFixed(2)}R` : pct(d)}${gain}<span class="h-x" data-act="remove" title="Quitar el TP">×</span>`;
}

const chart = new TicketChart($('tChart'), {
  labelOf: levelLabel,
  onDrag: (name, price) => { $(LEVEL_INPUT[name]).value = px(price); },
  onDrop: () => schedulePreview(),
  onRemove: name => {
    if (name === 'entry') { $('tType').value = 'market'; onTypeChange(); return; }
    $(LEVEL_INPUT[name]).value = '';
    schedulePreview();
  },
});

const chartSource = () => isSwing()
  ? { exchange: $('tExchange').value, market: $('tMarket').value }
  : { exchange: 'binance', market: $('tMarket').value === 'spot' ? 'spot' : 'futures' };

// Textos de la caja de la posicion abierta (lado, resultado, SL, TP)
function positionLabels(p) {
  const narrow = window.innerWidth < 700;
  const pct = v => `${v >= 0 ? '+' : ''}${fmt(v)}%`;
  const r0 = p.trade?.risk_usd || posRiskUsd(p);
  const rNow = r0 > 0 ? p.upnl / r0 : null;
  const risk = posRiskUsd(p);
  const rr = p.stop && p.tp && Math.abs(p.entry - p.stop) > 0 ? Math.abs(p.tp - p.entry) / Math.abs(p.entry - p.stop) : null;
  const S_ = p.side.toUpperCase();
  return {
    pnl: `${S_} · ${sign(p.upnl)} USDT${rNow != null ? ` · ${sign(rNow)}R` : ''}${p.stop ? '' : ' · SIN STOP'}`,
    pnlPos: p.upnl >= 0,
    ep: `${S_} ${narrow ? '' : (p.market === 'coinm' ? fmt(p.size, 0) + ' ct' : fmt(p.size, 4)) + ' · '}${px(p.entry)}`,
    sl: p.stop ? (narrow ? `SL ${px(p.stop)}${risk > 0 ? ` · −${fmt(risk)}` : ''}`
                         : `SL ${px(p.stop)} · ${pct((p.stop / p.entry - 1) * 100)}${risk > 0 ? ` · −${fmt(risk)} USDT` : ' · en ganancia'}`) : null,
    tp: p.tp ? (narrow ? `TP ${px(p.tp)}${rr ? ` · ${fmt(rr, 1)}R` : ''}`
                       : `TP ${px(p.tp)} · ${pct((p.tp / p.entry - 1) * 100)}${rr ? ` · ${fmt(rr, 1)}R` : ''}`) : null,
  };
}

// Pasa al grafico lo que dicen los campos del ticket y la posicion abierta del simbolo
function syncChart() {
  renderCtx();
  chart.setLevel('sl', +$('tStop').value || null);
  chart.setLevel('tp', +$('tTp').value || null);
  const sym = $('tSymbol').value.trim().toUpperCase(), ex = $('tExchange').value;
  // VWAP: sus posiciones ya son solo de su exchange; en swing tambien se cruza el exchange
  const pos = S ? positionsOf().find(p => p.symbol === sym && (!isSwing() || p.exchange === ex)) : null;
  // Con una posicion abierta en el simbolo no se puede abrir otra (no se promedia):
  // la etiqueta de orden a mercado no se muestra para no tapar la caja
  if ($('tType').value === 'limit') chart.setLevel('entry', +$('tEntry').value || null);
  else chart.setLevel('entry', pos ? null : M?.indicators?.price || null, { ghost: true });
  chart.setPosition(pos ? { ...pos, opened_at: pos.opened_at || pos.trade?.opened_at } : null, pos ? positionLabels(pos) : {});
}

window.chartAdd = name => {
  const ref = M?.indicators?.price || chart.lastPrice();
  if (!ref) return;
  const dir = side === 'long' ? 1 : -1;
  if (name === 'entry') {
    $('tType').value = 'limit';
    onTypeChange();
    $('tEntry').value = px(ref);
  } else if (name === 'sl') {
    $('tStop').value = px(ref * (1 - dir * 0.004));
  } else {
    const entry = refPrice();
    const stop = +$('tStop').value || entry * (1 - dir * 0.004);
    $('tTp').value = px(entry + dir * 2 * Math.abs(entry - stop));
  }
  schedulePreview();
};

// ── Reglas ────────────────────────────────────────────────────────────────────

function renderRules() {
  const form = $('rulesForm');
  if (!form.dataset.ready) {
    form.innerHTML = Object.entries(RULE_LABELS).map(([k, label]) => {
      const h = S.hard[k];
      return `<div class="form-field"><label>${label} <i>(${h.min}–${h.max})</i></label>
        <input type="number" step="any" min="${h.min}" max="${h.max}" data-rule="${k}" value="${S.rules[k]}"></div>`;
    }).join('') + `<label class="tm-check"><input type="checkbox" id="rBlockNews" ${S.rules.block_news ? 'checked' : ''}><span>No operar dias de noticias macro</span></label>`;
    $('rSymbols').value = S.rules.symbols.join(', ');
    $('rVwapEx').value = S.rules.vwap_exchanges.join(', ');
    $('rChecklist').value = S.rules.checklist.join('\n');
    const SW = { risk_pct: 'Riesgo por operacion (%)', max_open_risk_pct: 'Riesgo abierto maximo (%)',
                 leverage: 'Apalancamiento (fijo)', min_rr: 'R:R minimo' };
    $('swingRulesForm').innerHTML = Object.entries(SW).map(([k, label]) => {
      const h = S.swing_hard[k];
      return `<div class="form-field"><label>${label} <i>(${h.min}–${h.max})</i></label>
        <input type="number" step="any" min="${h.min}" max="${h.max}" data-swing="${k}" value="${S.rules.swing[k]}"></div>`;
    }).join('');
    $('rSwSymbols').value = S.rules.swing.symbols.join(', ');
    $('rSwChecklist').value = S.rules.swing.checklist.join('\n');
    form.dataset.ready = '1';
  }
  const p = S.pending;
  $('rulesPendingTag').textContent = p ? '· cambio en espera' : '';
  $('rulesPending').innerHTML = p ? `<div class="tm-pending">
      En espera hasta ${new Date(S.pending_at * 1000).toLocaleString('es')}: ${Object.entries(p).map(([k, v]) => `<b>${esc(k === 'swing' ? 'Swing' : RULE_LABELS[k] || k)}</b> → ${esc(Array.isArray(v) ? v.length + ' elementos' : typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a}: ${Array.isArray(b) ? b.length + ' elementos' : b}`).join(', ') : v)}`).join(' · ')}
      <button class="btn btn-sm" onclick="cancelPendingRules()">Cancelar cambio</button></div>` : '';
}

window.saveRules = async () => {
  const body = {};
  document.querySelectorAll('[data-rule]').forEach(i => { body[i.dataset.rule] = +i.value; });
  body.block_news = $('rBlockNews').checked;
  body.symbols = $('rSymbols').value.split(/[\s,;]+/).filter(Boolean);
  body.vwap_exchanges = $('rVwapEx').value.split(/[\s,;]+/).filter(Boolean);
  body.checklist = $('rChecklist').value.split('\n').map(x => x.trim()).filter(Boolean);
  body.swing = { symbols: $('rSwSymbols').value.split(/[\s,;]+/).filter(Boolean),
                 checklist: $('rSwChecklist').value.split('\n').map(x => x.trim()).filter(Boolean) };
  document.querySelectorAll('[data-swing]').forEach(i => { body.swing[i.dataset.swing] = +i.value; });
  try {
    const r = await exec.rules(body);
    const a = Object.keys(r.applied || {}).length, p = Object.keys(r.pending || {}).length;
    toast(a && p ? 'Lo que endurece ya aplica; lo que afloja espera 24h' : p ? 'Cambio en espera 24h' : a ? 'Reglas endurecidas' : 'Sin cambios');
    $('rulesForm').dataset.ready = '';
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
};
window.cancelPendingRules = async () => { await exec.cancelPending(); toast('Cambio cancelado'); loadStatus(true); };
window.selfLock = async () => {
  const reason = prompt('¿Por que te bloqueas hoy? (queda en la bitacora)');
  if (reason == null) return;
  try { await exec.lock({ reason }); toast('Bloqueado hasta medianoche NY'); loadStatus(true); }
  catch (e) { toast(errMsg(e), 'err'); }
};
window.confirmNews = async () => {
  if (!confirm('¿Revisaste un calendario economico y hoy no hay noticias de alto impacto en USD? Queda registrado.')) return;
  try { await exec.newsConfirm(); loadStatus(true); } catch (e) { toast(errMsg(e), 'err'); }
};
window.addNews = async () => {
  try { await exec.newsAdd({ date: $('nDate').value, title: $('nTitle').value }); toast('Dia bloqueado'); loadStatus(true); }
  catch (e) { toast(errMsg(e), 'err'); }
};

// ── Cuentas ───────────────────────────────────────────────────────────────────

function renderAccounts() {
  $('accounts').innerHTML = S.accounts.length ? S.accounts.map(a => `
    <div class="tm-acc">
      <b>${a.exchange === 'binance' ? 'Binance' : 'Bitget'}</b>
      <span class="tm-tag">${esc(a.env)}${a.mode ? ' · ' + esc(a.mode) : ''}</span>
      <span class="tm-tag ${a.profile === 'vwap' ? 'live' : ''}">${a.profile === 'vwap' ? 'estrategia VWAP' : 'swing · solo lectura'}</span>
      ${a.profile === 'vwap' ? `<span class="tm-tag ${a.dry_run ? '' : 'live'}">${a.dry_run ? 'simulacion' : 'REAL'}</span>` : ''}
      <span>${a.equity ? `${fmt(a.equity.total)} USDT (futuros ${fmt(a.equity.futures_equity)}${a.equity.coinm_value != null ? ` · COIN-M ${fmt(a.equity.coinm_value)}` : ''} · spot ${fmt(a.equity.spot_value)})` : '<span class="neg">sin lectura</span>'}</span>
      ${a.profile === 'vwap' ? `<button class="btn btn-sm" onclick="toggleMode('${a.exchange}', ${a.dry_run ? 'false' : 'true'})">${a.dry_run ? 'Pasar a real' : 'Volver a simulacion'}</button>` : ''}
      <button class="btn btn-sm btn-danger" onclick="removeAccount('${a.exchange}')">Quitar</button>
    </div>`).join('') : '<div class="tm-sub">Ninguna cuenta conectada</div>';
  const errs = [...(S.errors || []), ...(S.swing_errors || [])];
  if (errs.length) $('accounts').insertAdjacentHTML('beforeend', `<div class="tm-err">${errs.map(esc).join('<br>')}</div>`);
}

function openAccounts() {
  const panel = $('accountsPanel');
  panel.open = true;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.openAccounts = openAccounts;

window.onAccExchange = () => {
  const bg = $('aExchange').value === 'bitget';
  $('aPassField').classList.toggle('hidden', !bg);
  $('aEnvField').classList.toggle('hidden', bg);
};
window.connectAccount = async () => {
  try {
    const r = await exec.saveAccount({ exchange: $('aExchange').value, env: $('aEnv').value,
      key: $('aKey').value, secret: $('aSecret').value, passphrase: $('aPass').value });
    toast(`Conectada${r.mode ? ' (' + r.mode + ')' : ''}: ${fmt(r.equity?.total)} USDT`);
    ['aKey', 'aSecret', 'aPass'].forEach(id => { $(id).value = ''; });
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
};
window.toggleMode = async (exchange, dryRun) => {
  if (!dryRun && !confirm('En modo REAL el terminal envia ordenes y el guardian puede cerrar o recortar posiciones que rompan las reglas. ¿Activar?')) return;
  await exec.accountMode({ exchange, dry_run: dryRun });
  loadStatus(true);
};
window.removeAccount = async exchange => {
  if (!confirm(`¿Quitar ${exchange}? Se borran las llaves guardadas.`)) return;
  await exec.deleteAccount({ exchange });
  loadStatus(true);
};
window.runDiag = async () => {
  const el = $('diag');
  el.classList.remove('hidden');
  el.textContent = 'Probando…';
  try { el.textContent = JSON.stringify(await exec.diag(), null, 2); }
  catch (e) { el.textContent = errMsg(e); }
};

// ── Bitacora ──────────────────────────────────────────────────────────────────

window.loadEvents = async () => {
  try {
    const { events } = await exec.events(60);
    $('events').innerHTML = events.map(e => `<div class="tm-ev tm-ev-${esc(e.severity)}">
      <span>${new Date(e.ts * 1000).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      <span>${esc(e.message)}</span></div>`).join('') || '<div class="tm-sub">Sin eventos</div>';
  } catch (e) { $('events').innerHTML = `<div class="tm-err">${esc(errMsg(e))}</div>`; }
};

// ── Arranque ──────────────────────────────────────────────────────────────────

function tickClock() {
  $('nyClock').textContent = new Date().toLocaleTimeString('es', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' NY';
}

// Cada 20 s dentro de la ventana o con posiciones; si no, cada 60 s
let poll = null;
function startPolling() {
  clearTimeout(poll);
  const active = S && (S.window.in_window || S.positions.length || (isSwing() && S.swing_positions?.length) || S.open_trades.length);
  poll = setTimeout(async () => {
    if (document.visibilityState === 'visible') await loadStatus();
    startPolling();
  }, active ? 20000 : 60000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadStatus(); });

(async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  $('nDate').value = new Date().toISOString().slice(0, 10);
  applyStrategyUI();
  await loadStatus(true);
  loadMarket();
  loadEvents();
  startPolling();
  // Con la pestana oculta el WebSocket se cierra; al volver, si paso mas de un
  // minuto se recarga el historial (una peticion) para no dejar huecos.
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); feed.stop(); return; }
    if (!M) return;
    if (hiddenAt && Date.now() - hiddenAt > 60000) loadMarket();
    else if (M.candles) feed.start({ ...M, candles: feed.candles.map(k => [k.t, k.o, k.h, k.l, k.c, k.v]) });
    hiddenAt = null;
  });
})();
