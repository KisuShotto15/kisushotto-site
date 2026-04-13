import { getInsights, refreshInsights } from './api.js';

const $ = id => document.getElementById(id);
let allInsights = [];

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(insights) {
  const el = $('insightsContainer');
  if (!insights.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div>Sin insights. Necesitas al menos 10 trades cerrados.<br><br>Haz clic en "Regenerar insights" para analizarlos.</div>`;
    return;
  }
  const ICONS = { critical: '🔴', warning: '🟡', info: '🔵' };
  el.innerHTML = `<div class="insights-grid">
    ${insights.map(ins => `
      <div class="insight-card ${ins.severity}">
        <div class="insight-badge ${ins.severity}">${ICONS[ins.severity] || ''} ${ins.severity}</div>
        <div class="insight-title">${ins.title}</div>
        <div class="insight-desc">${ins.description}</div>
        <div class="insight-time">${new Date(ins.generated_at * 1000).toLocaleString('es', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}</div>
      </div>
    `).join('')}
  </div>`;
}

// ── Filter ────────────────────────────────────────────────────────────────────
window.filterInsights = function(severity, btn) {
  document.querySelectorAll('.isect-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const filtered = severity === 'all' ? allInsights : allInsights.filter(i => i.severity === severity);
  render(filtered);
};

// ── Refresh ───────────────────────────────────────────────────────────────────
window.doRefresh = async function() {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = '↻ Regenerando…';
  try {
    const { refreshed } = await refreshInsights();
    toast(`${refreshed} insights generados`);
    await load();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Regenerar insights';
  }
};

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  try {
    const { insights } = await getInsights();
    allInsights = insights;
    render(insights);
  } catch (err) {
    $('insightsContainer').innerHTML = `<div class="empty-state" style="color:var(--red)">${err.message}</div>`;
    toast(err.message, 'err');
  }
}

load();
