import { getAnalytics, getInsights, getTrades, ingestBybit, ingestBybitInverse, ingestBybitSpot, ingestBinance, ingestBinanceSpot, ingestCSV, getSyncConfig, setSyncConfig, runSync } from './api.js';
import { drawEquityCurve } from './charts.js';

const $ = id => document.getElementById(id);

function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

function fmtPnl(v) {
  const n = parseFloat(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' });
}

function renderKPIs(s) {
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

  const sc = s.currentStreak;
  const streakEl = $('streakInfo');
  if (!sc) {
    streakEl.textContent = '—';
    streakEl.style.color = 'var(--muted)';
  } else {
    streakEl.textContent = `${Math.abs(sc)} ${sc > 0 ? 'wins' : 'losses'} seguidos`;
    streakEl.style.color = sc > 0 ? 'var(--green)' : 'var(--red)';
  }

  const bwEl = $('bestWorst');
  const lines = [];
  if (s.bestTrade)  lines.push(`✅ Mejor: ${s.bestTrade.symbol} +${s.bestTrade.pnl.toFixed(2)} USDT (${fmtDate(s.bestTrade.entry_time)})`);
  if (s.worstTrade) lines.push(`❌ Peor: ${s.worstTrade.symbol} ${s.worstTrade.pnl.toFixed(2)} USDT (${fmtDate(s.worstTrade.entry_time)})`);
  if (s.avgHoldMinutes) lines.push(`⏱ Hold: ${s.avgHoldMinutes < 60 ? s.avgHoldMinutes + 'min' : Math.round(s.avgHoldMinutes / 60) + 'h'} promedio`);
  bwEl.innerHTML = lines.join('<br>') || '—';
}

function renderInsightsPreview(insights) {
  const el = $('insightsList');
  if (!insights.length) {
    el.innerHTML = '<div style="color:var(--muted);font-family:\'IBM Plex Mono\',monospace;font-size:12px;padding:16px 0">Sin insights. Ve a la página de Insights y regenera.</div>';
    return;
  }
  el.innerHTML = insights.slice(0, 4).map(ins => `
    <div style="padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px;color:${ins.severity==='critical'?'var(--red)':ins.severity==='warning'?'var(--amber)':'var(--accent)'}">${ins.severity}</div>
      <div style="font-weight:600;font-size:14px;margin-bottom:6px">${ins.title}</div>
      <div style="font-size:13px;color:var(--muted2);line-height:1.5">${ins.description}</div>
    </div>
  `).join('');
}

function renderRecentTrades(trades) {
  const el = $('recentTrades');
  if (!trades.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:16px 0;font-family:\'IBM Plex Mono\',monospace">Sin trades. Importa usando el botón.</div>';
    return;
  }
  el.innerHTML = `<div style="overflow-x:auto"><table style="min-width:unset">
    <thead><tr><th>Símbolo</th><th>Side</th><th>PnL</th><th>Fecha</th></tr></thead>
    <tbody>
      ${trades.slice(0, 8).map(t => `
        <tr>
          <td style="font-weight:600">${t.symbol}</td>
          <td class="side-${t.side}">${t.side.toUpperCase()}</td>
          <td class="${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${t.pnl != null ? fmtPnl(t.pnl) : '—'}</td>
          <td class="td-muted">${fmtDate(t.entry_time)}</td>
        </tr>`).join('')}
    </tbody>
  </table></div>`;
}

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
    { id: 'chk-linear',  fn: () => ingestBybit({ apiKey: key, apiSecret: secret, symbol }),          label: 'Linear' },
    { id: 'chk-inverse', fn: () => ingestBybitInverse({ apiKey: key, apiSecret: secret, symbol }),    label: 'Inverse' },
    { id: 'chk-spot',    fn: () => ingestBybitSpot({ apiKey: key, apiSecret: secret, symbol }),       label: 'Spot' },
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
    } catch (err) {
      lines.push(`${t.label}: ✗ ${err.message}`);
    }
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
    } catch (err) {
      lines.push(`${t.label}: ✗ ${err.message}`);
    }
  }

  resultEl.className = `ingest-result show ${totalNew > 0 ? 'ok' : 'err'}`;
  resultEl.innerHTML = lines.join('<br>');
  toast(`${totalNew} trades nuevos importados`);
  if (totalNew > 0) setTimeout(() => init(), 1200);
};

window.doIngestCSV = async function() {
  const file = $('csv-file')?.files?.[0];
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

async function init() {
  try {
    const [analyticsData, insightsData, tradesData] = await Promise.all([
      getAnalytics(),
      getInsights(),
      getTrades({ limit: 10, status: 'closed' }),
    ]);
    renderKPIs(analyticsData.stats);
    drawEquityCurve($('equityChart'), analyticsData.stats.equityCurve);
    renderInsightsPreview(insightsData.insights);
    renderRecentTrades(tradesData.trades);
  } catch (err) {
    toast('Error cargando datos: ' + err.message, 'err');
  }
}

init();
loadSyncStatus();
