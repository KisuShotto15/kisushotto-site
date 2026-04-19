import { getTrades, updateTrade } from './api.js';

const $ = id => document.getElementById(id);
let page = 0;
let filterDebounce = null;
let currentTrade = null;

// ── Tag definitions ───────────────────────────────────────────────────────────
const SETUP_TAGS = [
  'OB', 'FVG', 'FVG+OB', 'BOS', 'CHoCH', 'MSS',
  'BREAKER', 'RETEST', 'LIQUIDITY', 'STOP HUNT',
  'SNR', 'RECLAIM', 'IMBALANCE', 'TURTLE SOUP', 'TREND',
];
const STRATEGY_TAGS = [
  'ICT', 'Smart Money', 'Scalp', 'Swing', 'Reversal',
  'Continuation', 'Breakout', 'News', 'Grid',
];
const EMOTION_TAGS = [
  { label: 'Calm', color: '#4ade80' },
  { label: 'Confident', color: '#35c8f1' },
  { label: 'FOMO', color: '#fbbf24' },
  { label: 'Fear', color: '#f87171' },
  { label: 'Greed', color: '#fb923c' },
  { label: 'Revenge', color: '#f87171' },
  { label: 'Neutral', color: '#9494aa' },
];

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString('es', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}
function fmtNum(v, dec = 4) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(dec);
}
function fmtPnl(v) {
  const n = parseFloat(v);
  if (isNaN(n) || v == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
function fmtHoldTime(entry, exit) {
  if (!exit) return '—';
  const mins = Math.round((exit - entry) / 60);
  if (mins < 60)   return mins + 'm';
  if (mins < 1440) return Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
  return Math.floor(mins/1440) + 'd';
}

// ── Filters ───────────────────────────────────────────────────────────────────
function getFilters() {
  return {
    exchange: $('fExchange').value || undefined,
    category: $('fCategory').value || undefined,
    side:     $('fSide').value     || undefined,
    session:  $('fSession').value  || undefined,
    status:   $('fStatus').value   || undefined,
    symbol:   $('fSymbol').value   || undefined,
    from:     $('fFrom').value ? Math.floor(new Date($('fFrom').value).getTime() / 1000) : undefined,
    to:       $('fTo').value   ? Math.floor(new Date($('fTo').value + 'T23:59:59').getTime() / 1000) : undefined,
    page, limit: 50,
  };
}

window.applyFilters = function() { page = 0; load(); };
window.applyFiltersDebounced = function() {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(applyFilters, 400);
};
window.resetFilters = function() {
  ['fExchange','fCategory','fSide','fSession','fStatus','fFrom','fTo'].forEach(id => { $(id).value = ''; });
  $('fSymbol').value = '';
  page = 0;
  load();
};
window.prevPage = function() { if (page > 0) { page--; load(); } };
window.nextPage = function() { page++; load(); };

// ── Load & render ─────────────────────────────────────────────────────────────
async function load() {
  $('tradesBody').innerHTML = `<tr><td colspan="12"><div class="loading">Cargando…</div></td></tr>`;
  try {
    const { trades } = await getTrades(getFilters());
    renderTable(trades);
    $('pageInfo').textContent = `Página ${page + 1}`;
    $('btnPrev').disabled = page === 0;

    const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const wins = closed.filter(t => t.pnl > 0);
    $('miniSummary').innerHTML = [
      `<span>${trades.length} trades</span>`,
      closed.length ? `<span class="${totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT</span>` : '',
      closed.length ? `<span>${Math.round(wins.length / closed.length * 100)}% win</span>` : '',
    ].join('<span style="color:var(--border2)"> · </span>');
  } catch (err) {
    $('tradesBody').innerHTML = `<tr><td colspan="12" style="color:var(--red);font-family:'IBM Plex Mono',monospace;font-size:13px;padding:20px">${err.message}</td></tr>`;
    toast(err.message, 'err');
  }
}

function renderTable(trades) {
  if (!trades.length) {
    $('tradesBody').innerHTML = `<tr><td colspan="12"><div class="empty-state"><div class="empty-icon">📭</div>Sin trades con estos filtros</div></td></tr>`;
    return;
  }
  $('tradesBody').innerHTML = trades.map((t, i) => {
    const pnlClass = t.pnl > 0 ? 'pnl-pos' : t.pnl < 0 ? 'pnl-neg' : '';
    const hasNotes = t.notes || t.setup_tag || t.strategy_tag;
    return `
    <tr class="trade-row" data-id="${t.id}" onclick="openPanel(${JSON.stringify(t).replace(/"/g,'&quot;')})">
      <td class="td-muted">${page * 50 + i + 1}</td>
      <td class="td-symbol">${t.symbol}${hasNotes ? ' <span class="row-dot"></span>' : ''}</td>
      <td><span class="side-badge side-badge-${t.side}">${t.side.toUpperCase()}</span></td>
      <td>${fmtNum(t.entry_price, 4)}</td>
      <td class="td-muted">${t.exit_price != null ? fmtNum(t.exit_price, 4) : '—'}</td>
      <td class="td-muted">${fmtNum(t.size, 4)}</td>
      <td class="${pnlClass}" style="font-weight:600">${fmtPnl(t.pnl)}</td>
      <td class="td-muted">${t.session || '—'}</td>
      <td class="td-muted">${fmtHoldTime(t.entry_time, t.exit_time)}</td>
      <td>${t.setup_tag    ? `<span class="td-pill">${t.setup_tag}</span>`    : '<span class="td-muted">—</span>'}</td>
      <td>${t.strategy_tag ? `<span class="td-pill td-pill-blue">${t.strategy_tag}</span>` : '<span class="td-muted">—</span>'}</td>
      <td class="td-muted">${fmtDate(t.entry_time)}</td>
    </tr>`;
  }).join('');
}

// ── Side panel ────────────────────────────────────────────────────────────────
window.openPanel = function(t) {
  currentTrade = t;

  // Header
  $('panelSymbol').textContent = t.symbol;
  $('panelMeta').innerHTML = `
    <span class="side-badge side-badge-${t.side}" style="font-size:11px">${t.side.toUpperCase()}</span>
    <span style="color:var(--muted2);font-size:12px;margin-left:8px">${t.exchange || ''} · ${t.session || ''}</span>`;

  // Stats
  const pnlEl = $('panelPnl');
  pnlEl.textContent = fmtPnl(t.pnl) + ' USDT';
  pnlEl.className = `panel-stat-val ${t.pnl > 0 ? 'pnl-pos' : t.pnl < 0 ? 'pnl-neg' : ''}`;
  $('panelEntry').textContent = fmtNum(t.entry_price, 4);
  $('panelExit').textContent  = t.exit_price != null ? fmtNum(t.exit_price, 4) : '—';
  $('panelSize').textContent  = fmtNum(t.size, 4);

  // Setup tags
  renderTagGrid('tagSetup', SETUP_TAGS, t.setup_tag, 'setup');

  // Strategy tags
  renderTagGrid('tagStrategy', STRATEGY_TAGS, t.strategy_tag, 'strategy');

  // Emotion tags
  renderEmotionGrid(t.emotion);

  // Rule score
  renderRuleScore(t.rule_score);

  // Notes
  $('panelNotes').value = t.notes || '';

  // Open (remove hidden first so display isn't none during transition)
  $('sidePanel').classList.remove('hidden');
  $('panelBackdrop').classList.remove('hidden');
  requestAnimationFrame(() => $('sidePanel').classList.add('open'));
};

window.closePanel = function() {
  $('sidePanel').classList.remove('open');
  $('panelBackdrop').classList.add('hidden');
  setTimeout(() => $('sidePanel').classList.add('hidden'), 260);
  currentTrade = null;
};

function renderTagGrid(containerId, tags, selected, type) {
  const el = $(containerId);
  el.innerHTML = tags.map(tag => {
    const active = selected === tag;
    return `<button class="tag-pill ${active ? 'active' : ''}" data-type="${type}" data-val="${tag}" onclick="selectTag(this,'${type}')">${tag}</button>`;
  }).join('') +
  `<button class="tag-pill tag-pill-custom ${!selected || tags.includes(selected) ? '' : 'active'}" data-type="${type}" onclick="promptCustom(this,'${type}','${selected && !tags.includes(selected) ? selected : ''}')">${selected && !tags.includes(selected) ? selected : '+'}</button>`;
}

function renderEmotionGrid(selected) {
  const el = $('tagEmotion');
  el.innerHTML = EMOTION_TAGS.map(e => {
    const active = selected === e.label.toLowerCase();
    return `<button class="tag-pill emotion-pill ${active ? 'active' : ''}" data-type="emotion" data-val="${e.label.toLowerCase()}" onclick="selectTag(this,'emotion')" style="--dot:${e.color}">${e.label}</button>`;
  }).join('');
}

function renderRuleScore(current) {
  const el = $('ruleScoreRow');
  el.innerHTML = [0,1,2,3,4,5,6,7,8,9,10].map(n => {
    const active = current === n;
    return `<button class="score-btn ${active ? 'active' : ''}" onclick="selectScore(this,${n})">${n}</button>`;
  }).join('');
}

window.selectTag = function(btn, type) {
  const grid = btn.closest('.tag-grid');
  grid.querySelectorAll(`.tag-pill[data-type="${type}"]`).forEach(b => b.classList.remove('active'));
  const wasActive = btn.classList.contains('active');
  if (!wasActive) btn.classList.add('active');
};

window.selectScore = function(btn) {
  $('ruleScoreRow').querySelectorAll('.score-btn').forEach(b => b.classList.remove('active'));
  if (!btn.classList.contains('active')) btn.classList.add('active');
};

window.promptCustom = function(btn, type, existing) {
  const val = prompt(`Tag personalizado (${type}):`, existing || '');
  if (val === null) return;
  const trimmed = val.trim().toUpperCase();
  if (!trimmed) {
    btn.classList.remove('active');
    btn.textContent = '+';
    return;
  }
  btn.textContent = trimmed;
  btn.dataset.val = trimmed;
  // deselect others
  btn.closest('.tag-grid').querySelectorAll(`.tag-pill[data-type="${type}"]`).forEach(b => {
    if (b !== btn) b.classList.remove('active');
  });
  btn.classList.add('active');
};

window.savePanel = async function() {
  if (!currentTrade) return;

  const getActive = (type) => {
    const btn = document.querySelector(`.tag-pill.active[data-type="${type}"]`);
    return btn ? (btn.dataset.val || null) : null;
  };
  const scoreBtnActive = $('ruleScoreRow').querySelector('.score-btn.active');

  const body = {
    setup_tag:    getActive('setup'),
    strategy_tag: getActive('strategy'),
    emotion:      getActive('emotion'),
    rule_score:   scoreBtnActive ? parseInt(scoreBtnActive.textContent) : null,
    notes:        $('panelNotes').value.trim() || null,
  };

  try {
    await updateTrade(currentTrade.id, body);
    toast('Trade actualizado');
    // Update local cache
    currentTrade = { ...currentTrade, ...body };
    load();
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePanel();
});

load();
