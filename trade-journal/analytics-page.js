import { getAnalytics, getBySession, getBySymbol, getBySetup, getHeatmap } from './api.js';
import { drawEquityCurve, drawBars, drawHeatmap, drawWinLossBars } from './charts.js';

const $ = id => document.getElementById(id);

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(tab) {
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    const tabs = ['overview','sessions','symbols','setups','heatmap'];
    btn.classList.toggle('active', tabs[i] === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  $(`panel-${tab}`)?.classList.add('active');
  loadTab(tab);
};

const loaded = new Set();

async function loadTab(tab) {
  if (loaded.has(tab)) return;
  loaded.add(tab);
  try {
    switch (tab) {
      case 'overview':  await loadOverview(); break;
      case 'sessions':  await loadSessions(); break;
      case 'symbols':   await loadSymbols();  break;
      case 'setups':    await loadSetups();   break;
      case 'heatmap':   await loadHeatmap();  break;
    }
  } catch (err) {
    toast('Error: ' + err.message, 'err');
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────
async function loadOverview() {
  const { stats: s } = await getAnalytics();

  $('aWin').textContent  = '+' + s.avgWin.toFixed(2);
  $('aLoss').textContent = '-' + s.avgLoss.toFixed(2);
  $('aMaxW').textContent = s.maxWinStreak;
  $('aMaxL').textContent = s.maxLossStreak;

  drawEquityCurve($('analyticsEquity'), s.equityCurve);

  const wlEl = $('winLossBars');
  wlEl.style.height = '20px';
  drawWinLossBars(wlEl, s.winRate, s.closedCount);
  $('winLossLabels').innerHTML = `<span style="color:var(--green)">${s.winCount} wins</span><span style="color:var(--red)">${s.lossCount} losses</span>`;

  const bwEl = $('bestWorstDetail');
  const lines = [];
  const fmtDate = ts => new Date(ts * 1000).toLocaleDateString('es', { day:'2-digit', month:'short', year:'2-digit' });
  if (s.bestTrade)  lines.push(`<span style="color:var(--green)">✅ ${s.bestTrade.symbol} +${s.bestTrade.pnl.toFixed(2)} USDT · ${fmtDate(s.bestTrade.entry_time)}</span>`);
  if (s.worstTrade) lines.push(`<span style="color:var(--red)">❌ ${s.worstTrade.symbol} ${s.worstTrade.pnl.toFixed(2)} USDT · ${fmtDate(s.worstTrade.entry_time)}</span>`);
  if (s.avgHoldMinutes) lines.push(`<span>⏱ Hold promedio: ${s.avgHoldMinutes < 60 ? s.avgHoldMinutes + ' min' : Math.round(s.avgHoldMinutes / 60) + 'h'}</span>`);
  lines.push(`<span style="color:var(--accent)">🔒 Max Drawdown: ${s.maxDrawdown}%</span>`);
  bwEl.innerHTML = lines.join('<br>') || '—';
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function loadSessions() {
  const { data } = await getBySession();
  drawBars($('sessionPnlChart'), data.map(d => ({ label: d.label, value: d.totalPnl, count: d.count })));
  drawBars($('sessionWrChart'),  data.map(d => ({ label: d.label, value: d.winRate,  count: d.count })));
  $('sessionTable').innerHTML = renderDimTable(data);
}

// ── Symbols ───────────────────────────────────────────────────────────────────
async function loadSymbols() {
  const { data } = await getBySymbol();
  const top = data.slice(0, 10);
  drawBars($('symbolPnlChart'), top.map(d => ({ label: d.label, value: d.totalPnl, count: d.count })));
  drawBars($('symbolWrChart'),  top.map(d => ({ label: d.label, value: d.winRate,  count: d.count })));
  $('symbolTable').innerHTML = renderDimTable(data);
}

// ── Setups ────────────────────────────────────────────────────────────────────
async function loadSetups() {
  const { data } = await getBySetup();
  drawBars($('setupPnlChart'), data.map(d => ({ label: d.label, value: d.totalPnl, count: d.count })));
  drawBars($('setupExpChart'), data.map(d => ({ label: d.label, value: d.avgPnl,   count: d.count })));
  $('setupTable').innerHTML = renderDimTable(data);
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
async function loadHeatmap() {
  const { heatmap } = await getHeatmap();
  drawHeatmap($('heatmapChart'), heatmap);
}

// ── Shared table renderer ─────────────────────────────────────────────────────
function renderDimTable(data) {
  if (!data.length) return `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;font-family:'IBM Plex Mono',monospace;font-size:12px">Sin datos</td></tr>`;
  return data.map(d => `
    <tr>
      <td>${d.label}</td>
      <td>${d.count}</td>
      <td class="${d.winRate >= 50 ? 'pnl-pos' : 'pnl-neg'}">${d.winRate}%</td>
      <td class="${d.totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${d.totalPnl >= 0 ? '+' : ''}${d.totalPnl.toFixed(2)}</td>
      <td class="${d.avgPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${d.avgPnl >= 0 ? '+' : ''}${d.avgPnl.toFixed(2)}</td>
      <td class="${d.profitFactor >= 1 ? 'pnl-pos' : 'pnl-neg'}">${d.profitFactor >= 99 ? '∞' : d.profitFactor.toFixed(2)}</td>
    </tr>`).join('');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadTab('overview');
