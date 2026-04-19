import { getAnalytics, getTrades, getBySymbol, ingestBybit, ingestBybitInverse, ingestBybitSpot, ingestBinance, ingestBinanceSpot, ingestCSV, getSyncConfig, setSyncConfig, runSync } from './api.js';

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────────────────────────────────
let periodType  = 'month';
let customFrom  = null;
let customTo    = null;
const _now      = new Date();
let calYear     = _now.getFullYear();
let calMonth    = _now.getMonth();

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_ES   = ['LUN','MAR','MIÉ','JUE','VIE','SÁB','DOM'];

// ── Period helpers ─────────────────────────────────────────────────────────────
function getPeriodRange() {
  const n = new Date();
  if (periodType === 'month') {
    const y = n.getFullYear(), m = n.getMonth();
    return { from: ts(new Date(y, m, 1)), to: ts(new Date(y, m+1, 0, 23, 59, 59)) };
  }
  if (periodType === 'year') {
    const y = n.getFullYear();
    return { from: ts(new Date(y, 0, 1)), to: ts(new Date(y, 11, 31, 23, 59, 59)) };
  }
  return { from: customFrom, to: customTo };
}

function getCalRange() {
  return {
    from: ts(new Date(calYear, calMonth, 1)),
    to:   ts(new Date(calYear, calMonth+1, 0, 23, 59, 59)),
  };
}

function ts(d) { return Math.floor(d.getTime() / 1000); }

// ── Formatters ─────────────────────────────────────────────────────────────────
function fmtPnl(v) {
  const n = parseFloat(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
function fmtDate(unixTs) {
  return new Date(unixTs * 1000).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' });
}
function fmtHoldTime(entry, exit) {
  if (!exit) return '—';
  const mins = Math.round((exit - entry) / 60);
  if (mins < 60)   return mins + 'm';
  if (mins < 1440) return Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
  return Math.floor(mins/1440) + 'd';
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── KPIs ───────────────────────────────────────────────────────────────────────
function renderKPIs(s) {
  if (!s) return;

  const pnlEl = $('kpiPnl');
  pnlEl.textContent = fmtPnl(s.totalPnl);
  pnlEl.className   = `kpi-value ${s.totalPnl >= 0 ? 'pos' : 'neg'}`;

  const wrEl = $('kpiWr');
  wrEl.textContent = s.winRate + '%';
  wrEl.className   = `kpi-value ${s.winRate >= 50 ? 'pos' : 'neg'}`;
  $('kpiWrSub').textContent = `${s.winCount}W / ${s.lossCount}L`;

  const pfEl = $('kpiPf');
  pfEl.textContent = s.profitFactor >= 999 ? '∞' : s.profitFactor.toFixed(2);
  pfEl.className   = `kpi-value ${s.profitFactor >= 1 ? 'pos' : 'neg'}`;

  const expEl = $('kpiExp');
  expEl.textContent = fmtPnl(s.expectancy);
  expEl.className   = `kpi-value ${s.expectancy >= 0 ? 'pos' : 'neg'}`;

  const ddEl = $('kpiDD');
  ddEl.textContent = s.maxDrawdown + '%';
  ddEl.className   = `kpi-value ${s.maxDrawdown <= 10 ? 'neu' : 'neg'}`;

  $('kpiCount').textContent = s.closedCount;
  $('kpiOpen').textContent  = `abiertos: ${s.openCount}`;
}

// ── Calendar ───────────────────────────────────────────────────────────────────
function buildDayMap(trades) {
  const map = {};
  for (const t of trades) {
    if (t.pnl == null || t.status !== 'closed') continue;
    const d  = new Date(t.entry_time * 1000);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!map[ds]) map[ds] = { pnl: 0, count: 0 };
    map[ds].pnl   += t.pnl;
    map[ds].count++;
  }
  return map;
}

function renderCalendar(year, month, dayMap) {
  $('calTitle').textContent = `${MONTHS_ES[month]} ${year}`;

  // Month total
  const entries   = Object.values(dayMap);
  const monthPnl  = entries.reduce((s, d) => s + d.pnl, 0);
  const monthCount = entries.reduce((s, d) => s + d.count, 0);
  const statsEl   = $('calMonthStats');
  if (monthCount > 0) {
    statsEl.innerHTML = `<span class="cal-month-count">${monthCount}t</span><span class="cal-month-pnl ${monthPnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(monthPnl).replace(/\.00$/, '')}</span>`;
  } else {
    statsEl.innerHTML = '';
  }

  // Day headers
  let html = `<div class="cal-days-header">${DAYS_ES.map(d => `<div class="cal-day-label">${d}</div>`).join('')}</div>`;

  // Grid
  const firstDow  = new Date(year, month, 1).getDay();
  const offset    = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMon = new Date(year, month+1, 0).getDate();
  const todayD    = new Date();
  const todayStr  = `${todayD.getFullYear()}-${String(todayD.getMonth()+1).padStart(2,'0')}-${String(todayD.getDate()).padStart(2,'0')}`;

  html += '<div class="cal-grid-inner">';
  for (let i = 0; i < offset; i++) html += '<div class="cal-cell cal-cell-empty"></div>';

  for (let day = 1; day <= daysInMon; day++) {
    const ds   = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const data = dayMap[ds];
    const isToday = ds === todayStr;
    let cls = 'cal-cell';
    if (isToday) cls += ' cal-cell-today';
    if (data) cls += data.pnl >= 0 ? ' cal-cell-pos' : ' cal-cell-neg';

    html += `<div class="${cls}" onclick="openDayDrawer('${ds}')">
      <div class="cal-cell-top">
        <span class="cal-cell-day">${day}</span>
        ${data ? `<span class="cal-cell-count">${data.count}t</span>` : ''}
      </div>
      ${data ? `<div class="cal-cell-pnl ${data.pnl >= 0 ? 'pos' : 'neg'}">${data.pnl >= 0 ? '+' : ''}$${Math.abs(data.pnl).toFixed(0)}</div>` : ''}
    </div>`;
  }
  html += '</div>';
  $('calGrid').innerHTML = html;
}

// ── Calendar navigation ────────────────────────────────────────────────────────
window.calPrev = function() {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  loadCalendar();
};
window.calNext = function() {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  loadCalendar();
};
window.calGoToday = function() {
  const n = new Date();
  calYear  = n.getFullYear();
  calMonth = n.getMonth();
  loadCalendar();
};

async function loadCalendar() {
  $('calGrid').innerHTML = '<div class="loading">Cargando…</div>';
  const { from, to } = getCalRange();
  try {
    const { trades } = await getTrades({ from, to, status: 'closed', limit: 500 });
    renderCalendar(calYear, calMonth, buildDayMap(trades));
  } catch (e) {
    $('calGrid').innerHTML = `<div style="color:var(--red);font-family:monospace;font-size:12px;padding:20px">${e.message}</div>`;
  }
}

// ── Day Drawer ─────────────────────────────────────────────────────────────────
window.openDayDrawer = async function(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const from = ts(new Date(year, month-1, day, 0, 0, 0));
  const to   = ts(new Date(year, month-1, day, 23, 59, 59));

  $('dayDrawerDate').textContent = new Date(year, month-1, day)
    .toLocaleDateString('es', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const pnlEl = $('dayDrawerPnl');
  pnlEl.textContent = '—';
  pnlEl.className   = 'day-drawer-pnl neu';
  $('dayDrawerBody').innerHTML = '<div class="loading">Cargando…</div>';

  $('dayDrawer').classList.remove('hidden');
  $('dayDrawerBackdrop').classList.remove('hidden');
  requestAnimationFrame(() => $('dayDrawer').classList.add('open'));

  try {
    const { trades } = await getTrades({ from, to, limit: 100 });
    const closed  = trades.filter(t => t.pnl != null);
    const dayPnl  = closed.reduce((s, t) => s + t.pnl, 0);

    if (closed.length) {
      pnlEl.textContent = fmtPnl(dayPnl) + ' USDT';
      pnlEl.className   = `day-drawer-pnl ${dayPnl >= 0 ? 'pos' : 'neg'}`;
    }

    if (!trades.length) {
      $('dayDrawerBody').innerHTML = '<div class="drawer-empty">Sin trades este día</div>';
      return;
    }

    $('dayDrawerBody').innerHTML = trades.map(t => {
      const hold = fmtHoldTime(t.entry_time, t.exit_time);
      const pClass = t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : '';
      return `
        <div class="drawer-trade ${pClass}">
          <div class="drawer-trade-top">
            <span class="drawer-symbol">${t.symbol}</span>
            <span class="side-badge side-badge-${t.side}" style="font-size:10px">${t.side.toUpperCase()}</span>
            <span class="drawer-pnl ${pClass}" style="margin-left:auto">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</span>
          </div>
          <div class="drawer-trade-meta">
            <span>${t.exchange || ''}</span>
            <span>⏱ ${hold}</span>
            ${t.setup_tag ? `<span class="td-pill" style="font-size:9px;padding:2px 6px">${t.setup_tag}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    $('dayDrawerBody').innerHTML = `<div style="color:var(--red);font-size:12px;font-family:monospace;padding:12px">${e.message}</div>`;
  }
};

window.closeDayDrawer = function() {
  $('dayDrawer').classList.remove('open');
  $('dayDrawerBackdrop').classList.add('hidden');
  setTimeout(() => $('dayDrawer').classList.add('hidden'), 280);
};

// ── Top Tickers ────────────────────────────────────────────────────────────────
function renderTopTickers(symbols) {
  const el = $('topTickersList');
  if (!symbols || !symbols.length) {
    el.innerHTML = '<div class="sidebar-empty">Sin datos</div>';
    return;
  }
  const top      = symbols.slice(0, 7);
  const maxAbs   = Math.max(...top.map(s => Math.abs(s.totalPnl)), 0.01);
  el.innerHTML = top.map(s => {
    const pct  = (Math.abs(s.totalPnl) / maxAbs * 100).toFixed(1);
    const pos  = s.totalPnl >= 0;
    const sign = pos ? '+' : '';
    return `
      <div class="ticker-row">
        <div class="ticker-row-top">
          <span class="ticker-name">${s.symbol}</span>
          <span class="ticker-pnl ${pos ? 'pos' : 'neg'}">${sign}$${Math.abs(s.totalPnl).toFixed(0)}</span>
          <span class="ticker-count">${s.count}t</span>
        </div>
        <div class="ticker-bar-bg">
          <div class="ticker-bar ${pos ? 'pos' : 'neg'}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join('');
}

// ── Open Positions ─────────────────────────────────────────────────────────────
function renderOpenPositions(trades) {
  const open    = trades.filter(t => t.status === 'open');
  const openPnl = open.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalEl = $('openPnlTotal');
  const countEl = $('openCountLabel');
  const listEl  = $('openPosList');

  countEl.textContent = `${open.length} posicion${open.length !== 1 ? 'es' : ''} abierta${open.length !== 1 ? 's' : ''}`;

  if (!open.length) {
    totalEl.textContent = '—';
    totalEl.className   = 'open-pnl-total neu';
    listEl.innerHTML    = '<div class="sidebar-empty">Sin posiciones abiertas</div>';
    return;
  }
  totalEl.textContent = (openPnl >= 0 ? '+' : '') + '$' + Math.abs(openPnl).toFixed(2);
  totalEl.className   = `open-pnl-total ${openPnl >= 0 ? 'pos' : 'neg'}`;

  listEl.innerHTML = open.slice(0, 8).map(t => `
    <div class="open-pos-row">
      <span class="open-pos-symbol">${t.symbol}</span>
      <span class="side-badge side-badge-${t.side}" style="font-size:9px;padding:2px 6px">${t.side.toUpperCase()}</span>
      <span class="open-pos-pnl ${(t.pnl || 0) >= 0 ? 'pos' : 'neg'}">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</span>
    </div>`).join('');
}

// ── Profit Factor donut ────────────────────────────────────────────────────────
function renderProfitFactor(pf, grossWins, grossLosses) {
  const pfCard = $('pfCard');
  if (!pfCard) return;
  pfCard.style.display = '';

  const MAX    = 4;
  const capped = Math.min(pf >= 999 ? MAX : pf, MAX);
  const pct    = capped / MAX;
  const r = 44, cx = 60, cy = 60, sw = 10;
  const circ     = 2 * Math.PI * r;
  const dashFill = pct * circ;
  const dashGap  = circ - dashFill;
  const pfLabel  = pf >= 999 ? '∞' : pf.toFixed(2);

  const winStr  = grossWins  != null ? '+$' + grossWins.toFixed(0)  : '';
  const lossStr = grossLosses != null ? '-$' + Math.abs(grossLosses).toFixed(0) : '';

  $('pfPeriodLabel').textContent = { month: 'ESTE MES', year: 'ESTE AÑO', custom: 'CUSTOM' }[periodType] || 'ESTE MES';

  $('pfDonut').innerHTML = `
    <svg class="pf-donut-svg" viewBox="0 0 120 120" width="150" height="150">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#1c1d30" stroke-width="${sw}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="#f97316" stroke-width="${sw}"
        stroke-dasharray="${dashFill.toFixed(2)} ${dashGap.toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})"/>
      <text x="${cx}" y="${cy - 5}" text-anchor="middle"
        font-family="IBM Plex Mono,monospace" font-size="16" font-weight="600" fill="#e2e3f2">
        ${pfLabel}
      </text>
      <text x="${cx}" y="${cy + 11}" text-anchor="middle"
        font-family="IBM Plex Sans,sans-serif" font-size="9" fill="#8889a8">
        profit factor
      </text>
    </svg>
    ${winStr || lossStr ? `
    <div class="pf-donut-amounts">
      <span class="pf-win">${winStr}<small>Ganancias</small></span>
      <span class="pf-loss" style="text-align:right">${lossStr}<small>Pérdidas</small></span>
    </div>` : ''}`;
}

// ── Period selector ────────────────────────────────────────────────────────────
window.setPeriod = function(btn, type) {
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  periodType = type;
  $('customRange').classList.toggle('hidden', type !== 'custom');
  if (type !== 'custom') loadStats();
};

window.applyCustomPeriod = function() {
  const f = $('pFrom').value, t = $('pTo').value;
  if (!f || !t) { toast('Selecciona un rango de fechas', 'err'); return; }
  customFrom = ts(new Date(f));
  customTo   = ts(new Date(t + 'T23:59:59'));
  loadStats();
};

function updateTickerLabel() {
  const labels = { month: 'ESTE MES', year: 'ESTE AÑO', custom: 'CUSTOM' };
  const label = labels[periodType] || 'ESTE MES';
  $('tickerPeriodLabel').textContent = label;
  const pfLbl = $('pfPeriodLabel');
  if (pfLbl) pfLbl.textContent = label;
}

// ── Data loading ───────────────────────────────────────────────────────────────
async function loadStats() {
  updateTickerLabel();
  const { from, to } = getPeriodRange();
  try {
    const [analyticsData, symbolData, openData] = await Promise.all([
      getAnalytics({ from, to }),
      getBySymbol({ from, to }),
      getTrades({ status: 'open', limit: 50 }),
    ]);
    const s = analyticsData.stats;
    renderKPIs(s);
    renderTopTickers(symbolData.symbols || symbolData.data || []);
    renderOpenPositions(openData.trades || []);
    if (s && s.profitFactor != null) {
      const pf = s.profitFactor;
      // derive gross wins/losses if possible
      let grossWins = s.grossWins ?? null;
      let grossLosses = s.grossLosses ?? null;
      if (grossWins == null && pf > 1 && s.totalPnl > 0) {
        grossLosses = s.totalPnl / (pf - 1);
        grossWins   = grossLosses * pf;
      }
      renderProfitFactor(pf, grossWins, grossLosses);
    }
  } catch (err) {
    toast('Error cargando datos: ' + err.message, 'err');
  }
}

async function init() {
  await Promise.all([ loadStats(), loadCalendar() ]);
}

// ── Exchange / ingest functions (unchanged) ────────────────────────────────────
window.switchExchange = function(exchange, btn) {
  document.querySelectorAll('.isect-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.isect-panel').forEach(p => p.classList.remove('active'));
  $(`panel-${exchange}`)?.classList.add('active');
};

window.doIngestBybit = async function() {
  const key    = $('bybit-key').value.trim();
  const secret = $('bybit-secret').value.trim();
  const symbol = $('bybit-symbol').value.trim() || undefined;
  const resultEl = $('result-bybit');
  if (!key || !secret) { toast('API key y secret requeridos', 'err'); return; }
  const types = [
    { id: 'chk-linear',  fn: () => ingestBybit({ apiKey: key, apiSecret: secret, symbol }),         label: 'Linear' },
    { id: 'chk-inverse', fn: () => ingestBybitInverse({ apiKey: key, apiSecret: secret, symbol }),   label: 'Inverse' },
    { id: 'chk-spot',    fn: () => ingestBybitSpot({ apiKey: key, apiSecret: secret, symbol }),      label: 'Spot' },
  ].filter(t => $(t.id)?.checked);
  if (!types.length) { toast('Selecciona al menos un tipo', 'err'); return; }
  resultEl.className = 'ingest-result show';
  resultEl.textContent = `Importando ${types.map(t => t.label).join(', ')}…`;
  let totalNew = 0, lines = [];
  for (const t of types) {
    try {
      const res = await t.fn();
      totalNew += res.inserted;
      lines.push(`${t.label}: +${res.inserted} nuevos (${res.duplicates} dup)`);
    } catch (err) { lines.push(`${t.label}: ✗ ${err.message}`); }
  }
  resultEl.className = `ingest-result show ${totalNew > 0 ? 'ok' : 'err'}`;
  resultEl.innerHTML = lines.join('<br>');
  toast(`${totalNew} trades nuevos importados`);
  if (totalNew > 0) setTimeout(() => init(), 1200);
};

window.doIngestBinance = async function() {
  const key    = $('bn-key').value.trim();
  const secret = $('bn-secret').value.trim();
  const symbol = $('bn-symbol').value.trim();
  const resultEl = $('result-binance');
  if (!key || !secret || !symbol) { toast('API key, secret y símbolo requeridos', 'err'); return; }
  const types = [
    { id: 'chk-bn-futures', fn: () => ingestBinance({ apiKey: key, apiSecret: secret, symbol }),     label: 'Futures' },
    { id: 'chk-bn-spot',    fn: () => ingestBinanceSpot({ apiKey: key, apiSecret: secret, symbol }), label: 'Spot' },
  ].filter(t => $(t.id)?.checked);
  if (!types.length) { toast('Selecciona al menos un tipo', 'err'); return; }
  resultEl.className = 'ingest-result show';
  resultEl.textContent = `Importando ${types.map(t => t.label).join(', ')}…`;
  let totalNew = 0, lines = [];
  for (const t of types) {
    try {
      const res = await t.fn();
      totalNew += res.inserted;
      lines.push(`${t.label}: +${res.inserted} nuevos (${res.duplicates} dup)`);
    } catch (err) { lines.push(`${t.label}: ✗ ${err.message}`); }
  }
  resultEl.className = `ingest-result show ${totalNew > 0 ? 'ok' : 'err'}`;
  resultEl.innerHTML = lines.join('<br>');
  toast(`${totalNew} trades nuevos importados`);
  if (totalNew > 0) setTimeout(() => init(), 1200);
};

window.doIngestCSV = async function() {
  const file    = $('csv-file')?.files?.[0];
  const resultEl = $('result-csv');
  if (!file) { toast('Selecciona un archivo CSV', 'err'); return; }
  resultEl.className = 'ingest-result show';
  resultEl.textContent = 'Procesando CSV…';
  const csv = await file.text();
  try {
    const res = await ingestCSV({ csv });
    resultEl.className = `ingest-result show ${res.inserted > 0 ? 'ok' : 'err'}`;
    resultEl.textContent = `+${res.inserted} nuevos (${res.duplicates} dup) de ${res.total} filas`;
    toast(`${res.inserted} trades importados desde CSV`);
    if (res.inserted > 0) setTimeout(() => init(), 1200);
  } catch (err) {
    resultEl.className = 'ingest-result show err';
    resultEl.textContent = '✗ ' + err.message;
  }
};

window.doSaveSync = async function() {
  const key    = $('sync-key').value.trim();
  const secret = $('sync-secret').value.trim();
  const resultEl = $('result-sync');
  if (!key || !secret) { toast('API key y secret requeridos', 'err'); return; }
  resultEl.className = 'ingest-result show';
  resultEl.textContent = 'Guardando…';
  try {
    await setSyncConfig({ apiKey: key, apiSecret: secret, enabled: 1 });
    resultEl.className = 'ingest-result show ok';
    resultEl.textContent = '✓ Configuración guardada. Sync automático activo (cada 4h).';
    toast('Auto-sync configurado');
  } catch (err) {
    resultEl.className = 'ingest-result show err';
    resultEl.textContent = '✗ ' + err.message;
  }
};

window.doRunSync = async function() {
  const resultEl = $('result-sync');
  resultEl.className = 'ingest-result show';
  resultEl.textContent = 'Sincronizando…';
  try {
    const res = await runSync();
    resultEl.className = `ingest-result show ${res.inserted > 0 ? 'ok' : 'neu'}`;
    resultEl.textContent = res.skipped
      ? '⚠ Sin config guardada. Guarda tu API key primero.'
      : `✓ +${res.inserted} nuevos (${res.duplicates} dup)`;
    if (res.inserted > 0) setTimeout(() => init(), 1200);
  } catch (err) {
    resultEl.className = 'ingest-result show err';
    resultEl.textContent = '✗ ' + err.message;
  }
};

async function loadSyncStatus() {
  try {
    const { config } = await getSyncConfig();
    const el = $('sync-status');
    if (!el) return;
    if (config?.enabled) {
      const last = config.last_sync > 0
        ? new Date(config.last_sync * 1000).toLocaleString('es')
        : 'nunca';
      el.textContent = `✓ Activo · último sync: ${last}`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent = config ? '⏸ Desactivado' : 'Sin configurar';
      el.style.color = 'var(--muted)';
    }
  } catch (_) {}
}

init();
loadSyncStatus();
