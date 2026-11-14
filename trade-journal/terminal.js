// terminal.js — ticket de orden, estado de las reglas y posiciones.
// Toda la validacion real ocurre en el servidor; aqui solo se muestra.

import { exec } from './api.js';

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
let M = null;          // ultimo /exec/market
let side = 'long';
let lastPreview = null;
let previewTimer = null;

const RULE_LABELS = {
  risk_pct: 'Riesgo por operacion (%)', max_open_risk_pct: 'Riesgo abierto maximo (%)',
  daily_loss_pct: 'Perdida maxima diaria (%)', weekly_loss_pct: 'Perdida maxima semanal (%)',
  max_trades_day: 'Operaciones por dia', max_consec_losses: 'Perdidas seguidas que cierran el dia',
  cooldown_min: 'Pausa tras una perdida (min)', min_rr: 'R:R minimo', max_leverage: 'Apalancamiento maximo',
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
  const g = S.gates;
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

  renderWindow();
  renderNews();
  renderDay();
  renderPositions();
  renderSpot();
  renderPending();
  renderChecklist();
  renderAccounts();
  renderRules();
  fillExchanges();
  const acc = S.accounts.find(a => a.exchange === $('tExchange').value);
  $('ticketMode').textContent = !acc ? 'sin cuenta' : acc.dry_run ? 'SIMULACION' : 'REAL';
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
    $('newsSub').textContent = n.unknown ? 'Confirmado a mano' : 'Sin eventos de alto impacto en USD';
  }
  $('newsConfirm').classList.toggle('hidden', !(n.unknown && n.blocked && !n.events.length));

  $('newsList').innerHTML = S.news_list.length
    ? S.news_list.map(e => `<div class="tm-news-row"><b>${esc(e.date)}</b> <span>${esc(e.time)}</span> ${esc(e.title)} <i>${esc(e.source)}</i></div>`).join('')
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

function renderPositions() {
  const list = S.positions;
  $('posStamp').textContent = S.guardian_at ? `guardian hace ${Math.max(0, Math.round(Date.now() / 1000 - S.guardian_at))}s` : '';
  if (!list.length) { $('positions').innerHTML = '<div class="tm-sub">Sin posiciones abiertas</div>'; return; }
  $('positions').innerHTML = list.map((p, i) => {
    const risk = p.trade?.risk_usd || (p.stop ? Math.abs(p.entry - p.stop) * p.size : null);
    const rNow = risk ? p.upnl / risk : null;
    const be = p.side === 'long' ? p.mark > p.entry : p.mark < p.entry;
    return `<div class="tm-pos">
      <div class="tm-pos-line">
        <b>${esc(p.symbol)}</b>
        <span class="side-badge side-badge-${p.side}">${p.side.toUpperCase()}</span>
        <span class="tm-tag">${esc(p.exchange)}</span>
        ${p.trade ? '' : '<span class="tm-tag warn">externa</span>'}
        <span class="tm-pos-pnl ${p.upnl >= 0 ? 'pos' : 'neg'}">${sign(p.upnl)}${rNow != null ? ` · ${sign(rNow)}R` : ''}</span>
      </div>
      <div class="tm-pos-meta">
        <span>${fmt(p.size, 4)} @ ${px(p.entry)} → ${px(p.mark)}</span>
        <span class="${p.stop ? '' : 'neg'}">SL ${px(p.stop)}</span>
        <span>TP ${px(p.tp)}</span>
        ${p.leverage ? `<span>${p.leverage}x</span>` : ''}
        ${p.liq ? `<span>liq ${px(p.liq)}</span>` : ''}
        ${risk ? `<span>riesgo ${fmt(risk)} USDT</span>` : ''}
      </div>
      <div class="tm-row">
        ${be ? `<button class="btn btn-sm" onclick="posBreakeven(${i})">Stop a entrada</button>` : ''}
        <button class="btn btn-sm" onclick="posStop(${i})">Acercar stop</button>
        <button class="btn btn-sm" onclick="posClose(${i}, 50)">Cerrar 50%</button>
        <button class="btn btn-sm btn-danger" onclick="posClose(${i}, 100)">Cerrar</button>
      </div>
    </div>`;
  }).join('');
}

function renderPending() {
  const pend = S.open_trades.filter(t => t.status === 'pending');
  $('pending').innerHTML = pend.length ? pend.map(t => `<div class="tm-pos">
      <div class="tm-pos-line"><b>${esc(t.symbol)}</b><span class="side-badge side-badge-${t.side}">${t.side.toUpperCase()}</span>
      <span class="tm-tag">${esc(t.exchange)}</span><span>${fmt(t.qty, 4)} @ ${px(t.entry)}</span>
      <button class="btn btn-sm btn-danger" onclick="cancelPending('${esc(t.id)}')">Cancelar</button></div>
      <div class="tm-pos-meta"><span>SL ${px(t.stop)}</span><span>TP ${px(t.tp)}</span><span>riesgo ${fmt(t.risk_usd)} USDT</span></div>
    </div>`).join('') : '<div class="tm-sub">Sin ordenes limite pendientes</div>';
}

function renderSpot() {
  const rows = S.spot.filter(h => !h.stable).sort((a, b) => b.value - a.value);
  const stable = S.spot.filter(h => h.stable).reduce((s, h) => s + h.value, 0);
  $('spotTotal').textContent = `stables ${fmt(stable)} USDT`;
  const tradesBySym = new Map(S.open_trades.filter(t => t.market === 'spot').map(t => [`${t.exchange}|${t.symbol}`, t]));
  $('spot').innerHTML = rows.length ? rows.map(h => {
    const t = tradesBySym.get(`${h.exchange}|${h.symbol}`);
    return `<div class="tm-spot-row">
      <b>${esc(h.asset)}</b><span class="tm-tag">${esc(h.exchange)}</span>
      <span>${fmt(h.qty, 4)}</span><span>${fmt(h.value)} USDT</span>
      ${t ? `<span>SL ${px(t.stop)}</span>` : '<span class="tm-sub">fuera del terminal</span>'}
      ${t ? `<button class="btn btn-sm btn-danger" onclick="spotSell('${esc(h.exchange)}','${esc(h.symbol)}')">Vender</button>` : ''}
    </div>`;
  }).join('') : '<div class="tm-sub">Sin activos en spot</div>';
}

window.posBreakeven = i => moveStop(S.positions[i], S.positions[i].entry);
window.posStop = i => {
  const p = S.positions[i];
  const v = prompt(`Nuevo stop para ${p.symbol} (actual ${px(p.stop)}). Solo se puede acercar al precio.`, p.stop || '');
  if (v) moveStop(p, +v);
};
async function moveStop(p, stop) {
  try {
    const r = await exec.stop({ exchange: p.exchange, symbol: p.symbol, side: p.side, stop });
    toast(r.simulated ? 'Simulacion: el stop no se envio' : 'Stop actualizado');
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
}
window.posClose = async (i, pct) => {
  const p = S.positions[i];
  if (!confirm(`¿Cerrar ${pct}% de ${p.symbol} ${p.side.toUpperCase()} a mercado?`)) return;
  try {
    const r = await exec.close({ exchange: p.exchange, market: 'futures', symbol: p.symbol, side: p.side, pct });
    toast(r.simulated ? 'Simulacion: no se envio' : 'Orden de cierre enviada');
    loadStatus(true);
  } catch (e) { toast(errMsg(e), 'err'); }
};
window.spotSell = async (exchange, symbol) => {
  if (!confirm(`¿Vender todo ${symbol} a mercado y cancelar su stop?`)) return;
  try { await exec.close({ exchange, market: 'spot', symbol }); toast('Venta enviada'); loadStatus(true); }
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
  const list = S.accounts.length ? S.accounts.map(a => a.exchange) : ['binance', 'bitget'];
  const html = list.map(x => `<option value="${x}">${x === 'binance' ? 'Binance' : 'Bitget'}</option>`).join('');
  if (sel.innerHTML !== html) { sel.innerHTML = html; if (list.includes(cur)) sel.value = cur; }
}

function renderChecklist() {
  const box = $('checklist');
  const checked = new Set([...box.querySelectorAll('input:checked')].map(x => x.value));
  const items = S.rules.checklist;
  const sig = items.join('\n');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = items.map(c => `<label class="tm-check"><input type="checkbox" value="${esc(c)}" ${checked.has(c) ? 'checked' : ''} onchange="schedulePreview()"><span>${esc(c)}</span></label>`).join('');
}

window.setSide = s => {
  side = s;
  document.querySelectorAll('.tm-side').forEach(b => b.classList.toggle('active', b.dataset.side === s));
  schedulePreview();
};
window.onTypeChange = () => { $('tEntry').disabled = $('tType').value !== 'limit'; schedulePreview(); };
window.onMarketChange = () => {
  const spot = $('tMarket').value === 'spot';
  if (spot) { setSide('long'); $('tType').value = 'market'; onTypeChange(); }
  document.querySelector('.tm-side.short').disabled = spot;
  $('tType').disabled = spot;
  loadMarket();
};

function currentOrder() {
  return {
    exchange: $('tExchange').value, market: $('tMarket').value,
    symbol: $('tSymbol').value.trim().toUpperCase(), side, type: $('tType').value,
    entry: +$('tEntry').value || null, stop: +$('tStop').value || null, tp: +$('tTp').value || null,
    checklist: [...document.querySelectorAll('#checklist input:checked')].map(x => x.value),
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
      <div><span>Cantidad</span><b>${fmt(p.qty, 4)}</b></div>
      <div><span>Valor</span><b>${fmt(p.notional)} USDT</b></div>
      <div><span>Apalancamiento</span><b>${p.leverage ? p.leverage + 'x aislado' : '—'}</b></div>
      <div><span>R:R</span><b>${p.rr ? p.rr.toFixed(2) : '—'}</b></div>
      <div><span>Si salta el stop</span><b class="neg">-${fmt(p.loss_if_stop)} USDT · ${fmt(p.risk_pct)}%</b></div>
      <div><span>Si llega al objetivo</span><b class="pos">+${fmt(p.gain_if_tp)} USDT</b></div>
    </div>
    <div class="tm-sub">Precio ${px(p.price)} · entrada ${px(p.entry)} · comision ${(p.fee * 100).toFixed(3)}% incluida en el tamano</div>
    ${r.errors.length ? `<ul class="tm-errs">${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="tm-ok">Cumple todas las reglas</div>'}`;
}

function updateExecButton() {
  const b = $('execBtn');
  const ok = lastPreview?.ok;
  b.disabled = !ok;
  const acc = S?.accounts.find(a => a.exchange === $('tExchange').value);
  b.textContent = !ok ? (lastPreview ? 'Bloqueado por las reglas' : 'Revisa las reglas')
    : `${acc?.dry_run ? 'Simular' : 'Ejecutar'} ${side.toUpperCase()} · arriesgar ${fmt(lastPreview.plan.loss_if_stop)} USDT`;
  b.className = `tm-exec ${ok ? side : ''}`;
}

window.execute = () => {
  if (!lastPreview?.ok) return;
  const p = lastPreview.plan;
  $('confirmBody').innerHTML = `
    <div class="tm-confirm">
      <div class="tm-confirm-big ${side === 'long' ? 'pos' : 'neg'}">${side.toUpperCase()} ${esc(p.symbol)}</div>
      <div>${esc(p.exchange)} · ${p.market === 'spot' ? 'spot' : 'futuros'} · ${p.type === 'limit' ? 'limite ' + px(p.entry) : 'mercado'}</div>
      <div>Cantidad <b>${fmt(p.qty, 4)}</b> · stop <b>${px(p.stop)}</b> · objetivo <b>${px(p.tp)}</b></div>
      <div class="neg">Pierdes ${fmt(p.loss_if_stop)} USDT (${fmt(p.risk_pct)}%) si salta el stop. Es un resultado aceptado de antemano.</div>
      ${p.dry_run ? '<div class="warn">Cuenta en simulacion: no se envia nada al exchange.</div>' : ''}
    </div>`;
  $('confirmModal').classList.remove('hidden');
};
window.closeConfirm = () => $('confirmModal').classList.add('hidden');
window.confirmExecute = async () => {
  const btn = $('confirmGo');
  btn.disabled = true;
  try {
    const r = await exec.order(currentOrder());
    if (r.ok) {
      toast(r.simulated ? 'Simulacion registrada en la bitacora' : 'Orden enviada con stop');
      if (!r.simulated) {
        document.querySelectorAll('#checklist input').forEach(x => { x.checked = false; });
        $('tNotes').value = '';
      }
    } else toast(r.errors?.[0] || 'Rechazada', 'err');
    closeConfirm();
    await loadStatus(true);
    loadEvents();
    preview();
  } catch (e) { toast(errMsg(e), 'err'); }
  btn.disabled = false;
};

// ── Mercado e indicadores ─────────────────────────────────────────────────────

window.loadMarket = async () => {
  const symbol = $('tSymbol').value.trim().toUpperCase();
  if (!symbol) return;
  $('indStamp').textContent = 'cargando…';
  try {
    M = await exec.market({ exchange: $('tExchange').value, market: $('tMarket').value, symbol,
                            interval: $('tInterval').value, anchor: $('tAnchor').value });
    renderIndicators();
  } catch (e) {
    M = null;
    $('bands').innerHTML = `<div class="tm-err">${esc(errMsg(e))}</div>`;
    $('osc').innerHTML = '';
    $('indStamp').textContent = '';
  }
  schedulePreview();
};

function renderIndicators() {
  const s = M.indicators;
  if (!s) { $('bands').innerHTML = '<div class="tm-sub">Sin velas</div>'; return; }
  $('indStamp').textContent = `${new Date(s.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}${M.partial_vwap ? ' · VWAP parcial' : ''}`;
  const rows = [
    ...[3, 2, 1].map(n => ({ label: `+${n}σ`, v: s.bands[n - 1].up, z: n })),
    { label: 'VWAP', v: s.vwap, z: 0 },
    ...[1, 2, 3].map(n => ({ label: `−${n}σ`, v: s.bands[n - 1].dn, z: -n })),
  ];
  const at = Math.max(-3.5, Math.min(3.5, s.sigma));
  $('bands').innerHTML = rows.map(r => `
    <div class="tm-band ${Math.abs(r.z) === 3 ? 'x3' : Math.abs(r.z) === 2 ? 'x2' : ''} ${r.z === 0 ? 'mid' : ''} ${Math.round(at) === r.z ? 'here' : ''}">
      <span class="tm-band-label">${r.label}</span><span class="tm-band-px">${px(r.v)}</span>
      <button class="tm-mini" onclick="setLevel('tStop', ${r.v})">SL</button>
      <button class="tm-mini" onclick="setLevel('tTp', ${r.v})">TP</button>
    </div>`).join('') +
    `<div class="tm-band-now">Precio ${px(s.price)} · <b class="${Math.abs(s.sigma) >= 2 ? 'warn' : ''}">${s.sigma >= 0 ? '+' : ''}${s.sigma.toFixed(2)}σ</b></div>`;
  const rsiCls = s.rsi6 >= 80 ? 'neg' : s.rsi6 <= 20 ? 'pos' : '';
  const stCls = s.stoch_k >= 80 ? 'neg' : s.stoch_k <= 20 ? 'pos' : '';
  $('osc').innerHTML = `
    <div><span>RSI 6</span><b class="${rsiCls}">${fmt(s.rsi6, 1)}</b></div>
    <div><span>Estoc. RSI K/D</span><b class="${stCls}">${fmt(s.stoch_k, 1)} / ${fmt(s.stoch_d, 1)}</b></div>
    <div><span>Cruce</span><b>${s.stoch_cross === 'up' ? '↑ alcista' : s.stoch_cross === 'down' ? '↓ bajista' : '—'}</b></div>`;
}

window.setLevel = (id, v) => { $(id).value = px(v); schedulePreview(); };

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
    $('rChecklist').value = S.rules.checklist.join('\n');
    form.dataset.ready = '1';
  }
  const p = S.pending;
  $('rulesPendingTag').textContent = p ? '· cambio en espera' : '';
  $('rulesPending').innerHTML = p ? `<div class="tm-pending">
      En espera hasta ${new Date(S.pending_at * 1000).toLocaleString('es')}: ${Object.entries(p).map(([k, v]) => `<b>${esc(RULE_LABELS[k] || k)}</b> → ${esc(Array.isArray(v) ? v.length + ' elementos' : v)}`).join(' · ')}
      <button class="btn btn-sm" onclick="cancelPendingRules()">Cancelar cambio</button></div>` : '';
}

window.saveRules = async () => {
  const body = {};
  document.querySelectorAll('[data-rule]').forEach(i => { body[i.dataset.rule] = +i.value; });
  body.block_news = $('rBlockNews').checked;
  body.symbols = $('rSymbols').value.split(/[\s,;]+/).filter(Boolean);
  body.checklist = $('rChecklist').value.split('\n').map(x => x.trim()).filter(Boolean);
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
      <span class="tm-tag ${a.dry_run ? '' : 'live'}">${a.dry_run ? 'simulacion' : 'REAL'}</span>
      <span>${a.equity ? `${fmt(a.equity.total)} USDT (futuros ${fmt(a.equity.futures_equity)} · spot ${fmt(a.equity.spot_value)})` : '<span class="neg">sin lectura</span>'}</span>
      <button class="btn btn-sm" onclick="toggleMode('${a.exchange}', ${a.dry_run ? 'false' : 'true'})">${a.dry_run ? 'Pasar a real' : 'Volver a simulacion'}</button>
      <button class="btn btn-sm btn-danger" onclick="removeAccount('${a.exchange}')">Quitar</button>
    </div>`).join('') : '<div class="tm-sub">Ninguna cuenta conectada</div>';
  if (S.errors?.length) $('accounts').insertAdjacentHTML('beforeend', `<div class="tm-err">${S.errors.map(esc).join('<br>')}</div>`);
}

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

let poll = null;
function startPolling() {
  clearInterval(poll);
  poll = setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 20000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadStatus(); });

(async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  $('nDate').value = new Date().toISOString().slice(0, 10);
  await loadStatus(true);
  loadMarket();
  loadEvents();
  startPolling();
  setInterval(() => { if (document.visibilityState === 'visible' && M) loadMarket(); }, 60000);
})();
