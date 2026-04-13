import { getAnalytics, getInsights, getTrades, ingestBybit, ingestBybitInverse, ingestBybitSpot, ingestBinance, ingestBinanceSpot } from './api.js';
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
    el.innerHTML = '<div style="color:var(--muted);font-family:\'IBM Plex Mono\',monospace;font-size:11px;padding:12px 0">Sin insights. Ve a la página de Insights y regenera.</div>';
    return;
  }
  el.innerHTML = insights.slice(0, 4).map(ins => `
    <div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;color:${ins.severity==='critical'?'var(--red)':ins.severity==='warning'?'var(--amber)':'var(--accent)'}">${ins.severity}</div>
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">${ins.title}</div>
      <div style="font-size:11px;color:var(--muted2)">${ins.description}</div>
    </div>
  `).join('');
}

function renderRecentTrades(trades) {
  const el = $('recentTrades');
  if (!trades.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:12px 0;font-family:\'IBM Plex Mono\',monospace">Sin trades. Importa usando el botón.</div>';
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

window.switchIngestTab = function(tab) {
  const tabs = ['bybit-linear','bybit-inverse','bybit-spot','binance','binance-spot'];
  document.querySelectorAll('.isect-tab').forEach((btn, i) => btn.classList.toggle('active', tabs[i] === tab));
  document.querySelectorAll('.isect-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${tab}`)?.classList.add('active');
};

window.doIngest = async function(type) {
  const resultEl = $(`result-${type}`);
  resultEl.className = 'ingest-result show';
  resultEl.textContent = 'Importando…';
  try {
    let res;
    if (type === 'bybit-linear')
      res = await ingestBybit({ apiKey: $('bybit-key').value, apiSecret: $('bybit-secret').value, symbol: $('bybit-symbol').value || undefined });
    else if (type === 'bybit-inverse')
      res = await ingestBybitInverse({ apiKey: $('bybit-inv-key').value, apiSecret: $('bybit-inv-secret').value, symbol: $('bybit-inv-symbol').value || undefined });
    else if (type === 'bybit-spot')
      res = await ingestBybitSpot({ apiKey: $('bybit-sp-key').value, apiSecret: $('bybit-sp-secret').value, symbol: $('bybit-sp-symbol').value || undefined });
    else if (type === 'binance')
      res = await ingestBinance({ apiKey: $('bn-key').value, apiSecret: $('bn-secret').value, symbol: $('bn-symbol').value });
    else if (type === 'binance-spot')
      res = await ingestBinanceSpot({ apiKey: $('bn-sp-key').value, apiSecret: $('bn-sp-secret').value, symbol: $('bn-sp-symbol').value });

    resultEl.className = 'ingest-result show ok';
    resultEl.textContent = `✓ Total: ${res.total} · Nuevos: ${res.inserted} · Duplicados: ${res.duplicates}`;
    toast(`${res.inserted} trades nuevos importados`);
    setTimeout(() => init(), 1200);
  } catch (err) {
    resultEl.className = 'ingest-result show err';
    resultEl.textContent = `✗ ${err.message}`;
    toast(err.message, 'err');
  }
};

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
