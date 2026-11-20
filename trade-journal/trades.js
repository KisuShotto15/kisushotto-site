import { swr, invalidate } from './cache.js';
import { getTrades, updateTrade, bulkTag, downloadCSV, exec } from './api.js';
import { createChart, LineStyle } from 'lightweight-charts';
import { vwapBands, utcAnchor } from '../workers/trade-journal-worker/src/indicators.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 50;
let page = 0;
let trades = [];          // lo cargado hasta ahora (con "Cargar mas" se acumula)
let filterDebounce = null;
let currentTrade = null;
let currentScreenshots = [];
let selectMode = false;
const tradesMap = {};
const selectedIds = new Set();
const candleCache = new Map();

// ── Estado de filtros (se recuerda entre visitas) ─────────────────────────────
const SAVED = (() => { try { return JSON.parse(localStorage.getItem('tl_filters') || '{}'); } catch { return {}; } })();
let strat = SAVED.strat ?? 'vwap';
let range = SAVED.range ?? 'week';
let review = false;
const FIELDS = ['fExchange', 'fOrigin', 'fCategory', 'fSide', 'fSession', 'fStatus', 'fFrom', 'fTo', 'fSymbol', 'fSort'];
function saveFilters() {
  const o = { strat, range };
  for (const id of FIELDS) o[id] = $(id).value;
  try { localStorage.setItem('tl_filters', JSON.stringify(o)); } catch { /* sin storage */ }
}

// ── R ─────────────────────────────────────────────────────────────────────────
function riskOf(t) {
  if (t.risk_usd > 0) return t.risk_usd;
  if (t.stop_price > 0 && t.entry_price > 0 && t.size > 0) return Math.abs(t.entry_price - t.stop_price) * t.size;
  return null;
}
function rOf(t) {
  const risk = riskOf(t);
  return risk && t.pnl != null ? t.pnl / risk : null;
}
const fmtRv = r => r == null ? '—' : (r >= 0 ? '+' : '') + r.toFixed(2).replace('.', ',') + 'R';

// Los screenshots vivian dentro de strategy_tag; se leen de ahi solo por compatibilidad.
function screenshotsOf(t) {
  for (const raw of [t.screenshots, t.strategy_tag]) {
    if (!raw || !raw.startsWith('[')) continue;
    try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch { /* no era JSON */ }
  }
  return [];
}
const strategyOf = t => t.strategy_tag && !t.strategy_tag.startsWith('[') ? t.strategy_tag : null;

// ── Setups: valor guardado (igual que antes, para la analitica) y texto visible ─
const SETUPS = {
  VWAP: [
    ['VWAP 3σ reversion', 'Rebote en la banda 3'], ['VWAP 2σ reversion', 'Rebote en la banda 2'],
    ['Reversion a VWAP', 'Reversión a VWAP'], ['Rechazo en VWAP', 'Rechazo en el VWAP'],
    ['Ruptura y retest de banda', 'Ruptura y retest de banda'], ['FUERA DE PLAN', 'Fuera de plan'],
  ],
  Swing: ['Retest de soporte / resistencia', 'Ruptura con volumen', 'Pullback en tendencia', 'Rango: extremo a extremo', 'Otro']
    .map(x => [x, x]).concat([['FUERA DE PLAN', 'Fuera de plan']]),
};
const SETUP_LABEL = Object.fromEntries([...SETUPS.VWAP, ...SETUPS.Swing]);
const setupLabel = v => v ? v.split(',').map(x => SETUP_LABEL[x.trim()] || x.trim()).join(', ') : '';
const STRATEGY_TAGS = ['VWAP', 'Swing', 'Otra'];
const EMOTION_TAGS = [
  { key: 'calm', label: 'Tranquilo' }, { key: 'confident', label: 'Confiado' }, { key: 'anxious', label: 'Ansioso' },
  { key: 'impatient', label: 'Impaciente' }, { key: 'tired', label: 'Cansado' }, { key: 'fomo', label: 'FOMO' },
  { key: 'fear', label: 'Miedo' }, { key: 'greed', label: 'Codicia' }, { key: 'revenge', label: 'Revancha' },
  { key: 'neutral', label: 'Neutral' },
];
const needsReview = t => t.status === 'closed' && (!t.notes || t.emotion == null || t.rule_score == null);

// Senal guardada al entrar desde el terminal
function signalText(t) {
  let sig = null;
  try { sig = t.signal ? JSON.parse(t.signal) : null; } catch { /* sin senal */ }
  if (!sig) return '';
  const parts = [];
  if (sig.sigma != null) parts.push(bandWords(sig.sigma));
  if (sig.rsi6 != null) parts.push(`RSI6 ${sig.rsi6}`);
  if (sig.stoch_cross) parts.push(sig.stoch_cross === 'up' ? 'cruce alcista' : 'cruce bajista');
  if (sig.interval) parts.push(sig.interval);
  return parts.join(' · ');
}
function bandWords(z) {
  const a = Math.abs(z), dir = z >= 0 ? 'arriba' : 'abajo';
  if (a < 0.15) return 'precio en el VWAP';
  if (a < 1) return `precio entre el VWAP y la banda 1 de ${dir}`;
  if (a >= 3) return `precio por fuera de la banda 3 de ${dir}`;
  const n = Math.floor(a);
  return `precio entre la banda ${n} y la ${n + 1} de ${dir}`;
}

// ── Formato ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}
const num = (v, d = 2) => v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = v => v == null ? '—' : (v >= 0 ? '+' : '−') + num(Math.abs(v));
const pxf = v => v == null || !(+v) ? '—' : num(v, +v >= 1000 ? 1 : +v >= 1 ? 2 : 4);
const hm = ts => new Date(ts * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
function holdTime(a, b) {
  if (!b) return 'abierta';
  const m = Math.round((b - a) / 60);
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.floor(m / 1440)} d`;
}
const dayKey = ts => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(ts) {
  const s = new Date(ts * 1000).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'short' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

// ── Filtros ───────────────────────────────────────────────────────────────────
function rangeFrom() {
  const now = new Date();
  if (range === 'today') { now.setHours(0, 0, 0, 0); return Math.floor(now / 1000); }
  if (range === 'week') return Math.floor(Date.now() / 1000) - 7 * 86400;
  if (range === 'month') return Math.floor(Date.now() / 1000) - 30 * 86400;
  return undefined;
}
function getFilters() {
  const custom = $('fFrom').value || $('fTo').value;
  return {
    strat: strat || undefined,
    exchange: $('fExchange').value || undefined,
    category: $('fCategory').value || undefined,
    side: $('fSide').value || undefined,
    session: $('fSession').value || undefined,
    origin: $('fOrigin').value || undefined,
    status: $('fStatus').value || undefined,
    symbol: $('fSymbol').value.trim() || undefined,
    from: custom ? ($('fFrom').value ? Math.floor(new Date($('fFrom').value + 'T00:00:00') / 1000) : undefined) : rangeFrom(),
    to: custom && $('fTo').value ? Math.floor(new Date($('fTo').value + 'T23:59:59') / 1000) : undefined,
    review: review ? 1 : undefined,
    sort: $('fSort').value !== 'date' ? $('fSort').value : undefined,
  };
}
function paintControls() {
  document.querySelectorAll('#tlStrat button').forEach(b => b.classList.toggle('on', b.dataset.v === strat));
  const custom = $('fFrom').value || $('fTo').value;
  document.querySelectorAll('#tlRange button').forEach(b => b.classList.toggle('on', !custom && b.dataset.v === range));
  $('reviewBtn').classList.toggle('on', review);
  const extra = ['fExchange', 'fOrigin', 'fCategory', 'fSide', 'fSession', 'fStatus', 'fFrom', 'fTo'].filter(id => $(id).value).length;
  $('moreBtn').textContent = `Más filtros${extra ? ` (${extra})` : ''} ▾`;
}
window.setStrat = v => { strat = v; applyFilters(); };
window.setRange = v => { range = v; $('fFrom').value = ''; $('fTo').value = ''; applyFilters(); };
window.customRange = () => applyFilters();
window.toggleReview = () => { review = !review; applyFilters(); };
window.toggleMore = () => $('morePanel').classList.toggle('hidden');
window.applyFilters = () => { page = 0; saveFilters(); paintControls(); load(); };
window.applyFiltersDebounced = () => { clearTimeout(filterDebounce); filterDebounce = setTimeout(applyFilters, 400); };
window.resetFilters = () => {
  ['fExchange', 'fOrigin', 'fCategory', 'fSide', 'fSession', 'fStatus', 'fFrom', 'fTo', 'fSymbol'].forEach(id => { $(id).value = ''; });
  $('fSort').value = 'date';
  applyFilters();
};
window.loadMore = () => { page++; load(true); };

// ── Carga ─────────────────────────────────────────────────────────────────────
async function load(append = false) {
  if (!append) $('tradesBody').innerHTML = '<div class="loading">Cargando…</div>';
  const f = { ...getFilters(), page, limit: PAGE, totals: page === 0 ? 1 : undefined };
  try {
    const show = d => {
      trades = append ? [...trades.filter(t => !d.trades.some(x => x.id === t.id)), ...d.trades] : d.trades;
      if (d.totals) renderKpis(d.totals);
      renderList();
      $('loadMore').classList.toggle('hidden', d.trades.length < PAGE);
    };
    const d = await swr(`trades:${JSON.stringify(f)}`, () => getTrades(f), show);
    show(d);
  } catch (err) {
    $('tradesBody').innerHTML = `<div class="tl-err">${esc(err.message)}</div>`;
    toast(err.message, 'err');
  }
}

function renderKpis(t) {
  const n = t.n || 0, wins = t.wins || 0, losses = t.losses || 0;
  const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const rAvg = t.r_n ? t.r_sum / t.r_n : null;
  const k = (label, val, extra = '', c = '') => `<div class="tl-k"><span>${label}</span><b class="${c}">${val}</b>${extra ? `<small>${extra}</small>` : ''}</div>`;
  $('kpis').innerHTML =
    k('TRADES', n, `${plural(wins, 'ganada', 'ganadas')} · ${plural(losses, 'perdida', 'perdidas')}`) +
    k('P&amp;L NETO', usd(t.pnl || 0), 'USDT', cls(t.pnl)) +
    k('R TOTAL', fmtRv(t.r_n ? t.r_sum : null), t.r_n < n ? `${n - t.r_n} sin stop` : '', cls(t.r_sum)) +
    k('ACIERTOS', wins + losses ? `${Math.round(wins / (wins + losses) * 100)}%` : '—') +
    k('R PROMEDIO', fmtRv(rAvg), '', cls(rAvg)) +
    k('COMISIONES', t.fees ? '−' + num(t.fees) : '—', t.fees ? 'USDT registradas' : '', t.fees ? 'neg' : '');
  $('reviewCount').textContent = t.review || 0;
  $('reviewBtn').classList.toggle('zero', !t.review);
}

function rowHtml(t) {
  tradesMap[t.id] = t;
  const r = rOf(t);
  const long = t.side === 'long' || t.side === 'buy';
  const res = t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : '';
  const strat = strategyOf(t);
  const tags = [
    strat ? `<span class="tl-t ${strat === 'VWAP' ? 'v' : strat === 'Swing' ? 'sw' : ''}">${esc(strat)}</span>` : '',
    t.setup_tag ? `<span class="tl-t">${esc(setupLabel(t.setup_tag))}</span>` : '',
    t.rule_score != null ? `<span class="tl-t">disciplina ${t.rule_score}</span>` : '',
    t.exec_type === 'external' ? '<span class="tl-t w">externa</span>' : '',
    !riskOf(t) && t.status === 'closed' ? '<span class="tl-t w">sin stop</span>' : '',
    needsReview(t) ? '<span class="tl-t rv">por revisar</span>' : '',
    t.status === 'open' ? '<span class="tl-t">abierta</span>' : '',
  ].join('');
  return `<div class="tl-row ${res} ${currentTrade?.id === t.id ? 'open' : ''}" data-id="${t.id}">
    <div class="tl-main" onclick="openPanel('${t.id}')">
      ${selectMode ? `<input type="checkbox" class="tl-sel" ${selectedIds.has(t.id) ? 'checked' : ''} onclick="event.stopPropagation();toggleSelect('${t.id}',this.checked)">` : ''}
      <div class="tl-sym"><b>${esc(t.symbol)}</b><small>${hm(t.entry_time)} · ${esc(t.exchange || '')}</small></div>
      <span class="tl-side ${long ? 'l' : 's'}">${long ? 'LONG' : 'SHORT'}</span>
      <div class="tl-tags">${tags}</div>
      <div class="tl-pnl ${res}">${t.pnl != null ? usd(t.pnl) + ' USDT' : '—'}</div>
      <div class="tl-r ${res}">${fmtRv(r)}</div>
      <div class="tl-dur">${holdTime(t.entry_time, t.exit_time)}</div>
      <div class="tl-chev">›</div>
    </div>
    <div class="tl-detail"></div>
  </div>`;
}

function renderList() {
  if (!trades.length) {
    $('tradesBody').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div>${review ? 'No hay trades por revisar con estos filtros' : 'Sin trades con estos filtros'}</div>`;
    return;
  }
  let html = '';
  if ($('fSort').value === 'date') {
    // Agrupados por dia, con el resultado de cada dia
    const days = [];
    for (const t of trades) {
      const k = dayKey(t.entry_time);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, ts: t.entry_time, list: [] });
      days[days.length - 1].list.push(t);
    }
    for (const d of days) {
      const closed = d.list.filter(t => t.pnl != null);
      const pnl = closed.reduce((s, t) => s + t.pnl, 0);
      const rs = closed.map(rOf).filter(r => r != null);
      const w = closed.filter(t => t.pnl > 0).length, l = closed.filter(t => t.pnl < 0).length;
      html += `<div class="tl-day"><b>${dayLabel(d.ts)}</b><span>${plural(d.list.length, 'trade', 'trades')} · ${plural(w, 'ganada', 'ganadas')} · ${plural(l, 'perdida', 'perdidas')}</span>
        <span class="tl-day-r ${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${usd(pnl)} USDT${rs.length ? ' · ' + fmtRv(rs.reduce((a, b) => a + b, 0)) : ''}</span></div>`;
      html += d.list.map(rowHtml).join('');
    }
  } else {
    html = trades.map(rowHtml).join('');
  }
  $('tradesBody').innerHTML = html;
  renderBulkBar();
  // Si habia un trade abierto, se vuelve a abrir tras recargar
  if (currentTrade && tradesMap[currentTrade.id]) renderDetail(tradesMap[currentTrade.id]);
}

// ── Seleccion multiple ────────────────────────────────────────────────────────
window.toggleSelectMode = () => {
  selectMode = !selectMode;
  if (!selectMode) selectedIds.clear();
  $('selBtn').classList.toggle('on', selectMode);
  renderList();
};
window.toggleSelect = (id, checked) => { if (checked) selectedIds.add(id); else selectedIds.delete(id); renderBulkBar(); };
window.clearSelection = () => { selectedIds.clear(); document.querySelectorAll('.tl-sel').forEach(c => { c.checked = false; }); renderBulkBar(); };
window.selectAllVisible = () => { trades.forEach(t => selectedIds.add(t.id)); document.querySelectorAll('.tl-sel').forEach(c => { c.checked = true; }); renderBulkBar(); };
function renderBulkBar() {
  $('bulkBar').classList.toggle('show', selectMode && selectedIds.size > 0);
  $('bulkCount').textContent = `${selectedIds.size} seleccionado${selectedIds.size !== 1 ? 's' : ''}`;
}
const bulkOptions = list => ['<option value="">— elegir —</option>', ...list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`),
  '<option value="__clear__">(quitar)</option>'].join('');
window.applyBulkTag = async (field, value) => {
  if (!value || !selectedIds.size) return;
  const body = { ids: [...selectedIds], [field]: value === '__clear__' ? null : value };
  try {
    const res = await bulkTag(body);
    invalidate();
    toast(`${res.updated} trades etiquetados`);
    clearSelection();
    load();
  } catch (err) { toast(err.message, 'err'); }
};
window.doExport = async () => {
  const { from, to } = getFilters();
  try { await downloadCSV({ from, to }); toast('CSV descargado'); } catch (err) { toast(err.message, 'err'); }
};

// ── Detalle ───────────────────────────────────────────────────────────────────
window.openPanel = id => {
  const t = tradesMap[id];
  if (!t) return;
  const wasOpen = currentTrade?.id === id;
  closePanel();
  if (wasOpen) return;
  currentTrade = t;
  renderDetail(t);
};
window.closePanel = () => {
  document.querySelectorAll('.tl-row.open').forEach(c => { c.classList.remove('open'); c.querySelector('.tl-detail').innerHTML = ''; });
  currentTrade = null;
};

function renderDetail(t) {
  const row = document.querySelector(`.tl-row[data-id="${t.id}"]`);
  if (!row) return;
  row.classList.add('open');
  currentScreenshots = screenshotsOf(t);
  const strat = strategyOf(t) || (strat0() === 'swing' ? 'Swing' : 'VWAP');
  const setups = SETUPS[strat] || SETUPS.VWAP;
  const sel = (t.setup_tag || '').split(',').map(x => x.trim()).filter(Boolean)[0] || '';
  const custom = sel && !setups.some(([v]) => v === sel) ? sel : '';
  const sig = signalText(t);
  row.querySelector('.tl-detail').innerHTML = `
    <div class="tl-dg">
      <div>
        <div class="tl-chart" id="tlChart"><div class="tl-chart-msg">Cargando gráfico…</div></div>
        <div class="tl-stats">
          <div><span>ENTRADA</span><b class="c-entry">${pxf(t.entry_price)}</b></div>
          <div><span>SALIDA</span><b>${pxf(t.exit_price)}</b></div>
          <div><span>SL / TP</span><b><i class="neg">${pxf(t.stop_price)}</i> / <i class="pos">${pxf(t.tp_price)}</i></b></div>
          <div><span>TAMAÑO</span><b>${num(t.size, 4)}</b></div>
          <div><span>COMISIONES</span><b>${t.fees ? num(t.fees) : '—'}</b></div>
          <div><span>DURACIÓN</span><b>${holdTime(t.entry_time, t.exit_time)}</b></div>
        </div>
        ${sig ? `<div class="tl-note">Señal al entrar: ${esc(sig)}</div>` : ''}
        ${t.exec_type === 'external' ? '<div class="tl-note warn">Operación hecha fuera del terminal: no pasó por las reglas ni el checklist.</div>' : ''}
      </div>
      <div class="tl-form">
        <span>SETUP</span>
        <div class="tl-pills" id="pSetup">${setups.map(([v, l]) => `<button class="tl-pl ${v === sel ? 'on' : ''}" data-v="${esc(v)}" onclick="pick(this)">${esc(l)}</button>`).join('')}
          <button class="tl-pl ${custom ? 'on' : ''}" data-v="${esc(custom)}" onclick="pickCustom(this)">${custom ? esc(custom) : '+ otro'}</button></div>
        <span>EMOCIÓN</span>
        <div class="tl-pills" id="pEmotion">${EMOTION_TAGS.map(e => `<button class="tl-pl ${t.emotion === e.key || t.emotion === e.label ? 'on' : ''}" data-v="${e.key}" onclick="pick(this)">${e.label}</button>`).join('')}</div>
        <span>DISCIPLINA (0–10): ¿CUÁNTO SEGUISTE EL PLAN?</span>
        <div class="tl-score" id="pScore">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<button class="${t.rule_score === n ? 'on' : ''}" data-v="${n}" onclick="pick(this)">${n}</button>`).join('')}</div>
        <span>NOTAS</span>
        <textarea id="pNotes" placeholder="¿Seguiste el plan? ¿Qué harías distinto?">${esc(t.notes || '')}</textarea>
        <div class="tl-two">
          <div><span>STOP (PARA LA R)${t.stop_source === 'exchange' ? ' · tomado del exchange' : ''}</span>
            <input type="number" step="any" id="pStop" class="tl-in" value="${t.stop_price ?? ''}" oninput="previewRisk()"><small id="pRisk"></small></div>
          <div><span>ESTRATEGIA</span>
            <div class="tl-pills" id="pStrat">${STRATEGY_TAGS.map(s => `<button class="tl-pl ${strategyOf(t) === s ? 'on' : ''}" data-v="${s}" onclick="pick(this)">${s}</button>`).join('')}</div></div>
        </div>
        <span>CAPTURAS</span>
        <div class="tl-shots" id="pShots"></div>
        <input type="text" id="pShotIn" class="tl-in" placeholder="Pega un enlace de TradingView, Gyazo o Imgur y pulsa Enter"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addShot()}">
      </div>
    </div>
    <div class="tl-foot">
      <button class="tl-btn" onclick="closePanel()">Cerrar</button>
      <button class="tl-btn" onclick="savePanel(false)">Guardar</button>
      <button class="tl-save" onclick="savePanel(true)">Guardar y siguiente por revisar →</button>
    </div>`;
  renderShots();
  previewRisk();
  drawTradeChart(t);
  requestAnimationFrame(() => row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}
const strat0 = () => strat;

window.pick = btn => {
  const box = btn.parentElement;
  const was = btn.classList.contains('on');
  box.querySelectorAll('button').forEach(b => b.classList.remove('on'));
  if (!was) btn.classList.add('on');
};
window.pickCustom = btn => {
  const v = prompt('Setup:', btn.dataset.v || '');
  if (v === null) return;
  btn.dataset.v = v.trim();
  btn.textContent = v.trim() || '+ otro';
  btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('on'));
  if (v.trim()) btn.classList.add('on');
};
const picked = id => $(id)?.querySelector('button.on')?.dataset.v ?? null;

window.previewRisk = () => {
  const t = currentTrade, el = $('pRisk');
  if (!t || !el) return;
  const stop = parseFloat($('pStop').value);
  if (!(stop > 0) || !(t.entry_price > 0) || !(t.size > 0)) { el.textContent = 'Sin stop no hay R'; el.className = ''; return; }
  const risk = Math.abs(t.entry_price - stop) * t.size;
  const r = t.pnl != null && risk > 0 ? t.pnl / risk : null;
  el.textContent = `Riesgo ${num(risk)} USDT${r != null ? ' · ' + fmtRv(r) : ''}`;
  el.className = r == null ? '' : r >= 0 ? 'pos' : 'neg';
};

function renderShots() {
  $('pShots').innerHTML = currentScreenshots.map((url, i) => `<div class="tl-shot">
    <img src="${esc(url)}" alt="" onclick="openLightbox(${i})" onerror="this.replaceWith(Object.assign(document.createElement('a'),{href:this.src,target:'_blank',textContent:'abrir enlace'}))">
    <button onclick="removeShot(${i})">×</button></div>`).join('');
}
window.addShot = () => {
  const v = $('pShotIn').value.trim();
  if (!v) return;
  currentScreenshots.push(v);
  $('pShotIn').value = '';
  renderShots();
};
window.removeShot = i => { currentScreenshots.splice(i, 1); renderShots(); };
window.openLightbox = i => {
  const url = currentScreenshots[i];
  document.getElementById('td-lightbox')?.remove();
  const lb = document.createElement('div');
  lb.id = 'td-lightbox';
  lb.className = 'tl-lightbox';
  lb.innerHTML = `<img src="${esc(url)}" alt="">`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
};

window.savePanel = async next => {
  const t = currentTrade;
  if (!t) return;
  const stop = parseFloat($('pStop').value);
  const setup = picked('pSetup');
  const body = {
    setup_tag: setup || null,
    strategy_tag: picked('pStrat'),
    screenshots: currentScreenshots.length ? JSON.stringify(currentScreenshots) : null,
    emotion: picked('pEmotion'),
    rule_score: picked('pScore') != null ? +picked('pScore') : null,
    notes: $('pNotes').value.trim() || null,
    stop_price: stop > 0 ? stop : null,
  };
  try {
    await updateTrade(t.id, body);
    invalidate();
    toast('Trade guardado');
    const saved = { ...t, ...body };
    tradesMap[t.id] = saved;
    trades = trades.map(x => x.id === t.id ? saved : x);
    // Siguiente por revisar: el proximo de la lista al que le falte algo
    const i = trades.findIndex(x => x.id === t.id);
    const nxt = next ? [...trades.slice(i + 1), ...trades.slice(0, i)].find(needsReview) : null;
    currentTrade = nxt || (next ? null : saved);
    renderList();
    if (next && !nxt) toast('No quedan trades por revisar en esta lista');
    load();   // refresca totales y el contador
  } catch (err) { toast(err.message, 'err'); }
};

// ── Grafico del trade ─────────────────────────────────────────────────────────
// Una peticion por trade abierto (se guarda en memoria mientras la pagina este abierta)
async function drawTradeChart(t) {
  const box = $('tlChart');
  if (!box) return;
  const end0 = (t.exit_time || Math.floor(Date.now() / 1000)) * 1000;
  const dur = end0 - t.entry_time * 1000;
  const interval = dur <= 3 * 3600e3 ? '5m' : dur <= 12 * 3600e3 ? '15m' : dur <= 3 * 86400e3 ? '1h' : '4h';
  const end = Math.min(Date.now(), end0 + Math.max(dur * 0.4, 45 * 60e3));
  // Desde las 00:00 UTC del dia de entrada (ancla del VWAP) o mas atras en operaciones largas
  const dayStart = Math.floor(t.entry_time * 1000 / 86400000) * 86400000;
  const start = ['5m', '15m'].includes(interval) ? dayStart : t.entry_time * 1000 - Math.max(dur * 0.5, 86400e3);
  const market = t.category === 'spot' ? 'spot' : t.category === 'inverse' ? 'coinm' : 'futures';
  const key = `${t.id}|${interval}`;
  let candles = candleCache.get(key);
  if (!candles) {
    try {
      // Los futuros USDT se ven sobre el perpetuo de Binance (el de mas volumen), como en el terminal
      const src = market === 'futures' ? 'binance' : t.exchange;
      const m = await exec.market({ exchange: src, market, symbol: t.symbol, interval, anchor: 'utc', start, end });
      candles = (m.candles || []).map(([tt, o, h, l, c, v]) => ({ t: tt, o, h, l, c, v })).filter(k => k.t >= start);
      candleCache.set(key, candles);
    } catch (e) {
      box.innerHTML = `<div class="tl-chart-msg">No se pudo cargar el gráfico: ${esc(e.message)}</div>`;
      return;
    }
  }
  if (currentTrade?.id !== t.id || !document.body.contains(box)) return;
  if (!candles.length) { box.innerHTML = '<div class="tl-chart-msg">Sin velas para este periodo</div>'; return; }
  box.innerHTML = '';
  const chart = createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0c0c0c' }, textColor: '#8a8a8a', fontFamily: 'IBM Plex Mono, monospace', fontSize: 10 },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderColor: '#1f1f1f' }, timeScale: { borderColor: '#1f1f1f', timeVisible: true },
  });
  // Mismas velas que el terminal: cuerpo al 30%, borde y mecha solidos
  const s = chart.addCandlestickSeries({ upColor: 'rgba(181,160,227,0.3)', downColor: 'rgba(126,85,200,0.3)', borderVisible: true,
    borderUpColor: '#b5a0e3', borderDownColor: '#7e55c8', wickUpColor: '#b5a0e3', wickDownColor: '#5b31b0', priceLineVisible: false });
  s.setData(candles.map(k => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c })));
  const line = c => chart.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const b = vwapBands(candles, utcAnchor);
  const pt = (i, value) => {
    const d = { time: Math.floor(candles[i].t / 1000), value };
    if (i + 1 < candles.length && utcAnchor(candles[i].t) !== utcAnchor(candles[i + 1].t)) d.color = 'transparent';
    return d;
  };
  line('#3b6cf6').setData(b.map((x, i) => pt(i, x.vwap)));
  [['#2fa84f', 1], ['#e3c430', 2], ['#e5484d', 3]].forEach(([c, n]) => {
    line(c).setData(b.map((x, i) => pt(i, x.vwap + n * x.sd)));
    line(c).setData(b.map((x, i) => pt(i, x.vwap - n * x.sd)));
  });
  const lvl = (price, color, title, style = LineStyle.Dashed) => price > 0 && s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
  lvl(t.entry_price, '#93c5fd', 'Entrada', LineStyle.Dotted);
  lvl(t.stop_price, '#ef4444', 'SL');
  lvl(t.tp_price, '#00c896', 'TP');
  // Marcas en la vela de entrada y la de salida
  const at = ts => { let best = candles[0]; for (const k of candles) if (k.t <= ts * 1000) best = k; return Math.floor(best.t / 1000); };
  const long = t.side === 'long' || t.side === 'buy';
  const marks = [{ time: at(t.entry_time), position: long ? 'belowBar' : 'aboveBar', color: '#93c5fd', shape: long ? 'arrowUp' : 'arrowDown', text: 'Entrada' }];
  if (t.exit_time) marks.push({ time: at(t.exit_time), position: long ? 'aboveBar' : 'belowBar', color: t.pnl >= 0 ? '#00c896' : '#ef4444', shape: long ? 'arrowDown' : 'arrowUp', text: 'Salida' });
  s.setMarkers(marks.sort((a, b2) => a.time - b2.time));
  chart.timeScale().fitContent();
}

// ── Inicio ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { document.getElementById('td-lightbox')?.remove(); closePanel(); renderList(); }
});
for (const id of FIELDS) if (SAVED[id] != null) $(id).value = SAVED[id];
$('bulkSetup').innerHTML = bulkOptions([...SETUPS.VWAP, ...SETUPS.Swing.filter(([v]) => v !== 'FUERA DE PLAN')]);
$('bulkStrategy').innerHTML = bulkOptions(STRATEGY_TAGS.map(s => [s, s]));
paintControls();
load();
