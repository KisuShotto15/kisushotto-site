import { getTrades, updateTrade } from './api.js';

const $ = id => document.getElementById(id);
let page = 0;
let filterDebounce = null;
let currentTrade = null;
const tradesMap = {};
let currentTags = [];
let currentScreenshots = [];

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
function fmtShortDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en', { month:'short', day:'numeric' }) + ' ' +
         d.toLocaleTimeString('en', { hour:'2-digit', minute:'2-digit', hour12:false });
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
  $('tradesBody').innerHTML = `<div class="loading">Cargando…</div>`;
  try {
    const { trades } = await getTrades(getFilters());
    renderCards(trades);
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
    $('tradesBody').innerHTML = `<div style="color:var(--red);font-family:'IBM Plex Mono',monospace;font-size:13px;padding:20px">${err.message}</div>`;
    toast(err.message, 'err');
  }
}

function renderCards(trades) {
  if (!trades.length) {
    $('tradesBody').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div>Sin trades con estos filtros</div>`;
    return;
  }
  $('tradesBody').innerHTML = trades.map(t => {
    const isWin  = t.pnl > 0;
    const isLoss = t.pnl < 0;
    const pnlClass  = isWin ? 'pos' : isLoss ? 'neg' : 'neu';
    const isLong    = t.side === 'long' || t.side === 'buy';
    const sideClass = isLong ? 'pos' : 'neg';
    const sideArrow = isLong ? '↗' : '↘';
    const sideLabel = t.side.charAt(0).toUpperCase() + t.side.slice(1);
    const iconChar  = t.symbol.replace(/USDT|USDC|BTC|PERP/g, '').charAt(0) || t.symbol.charAt(0);

    let pctChange = 'neu';
    let pctText   = '—';
    if (t.entry_price && t.exit_price && t.entry_price !== 0) {
      const pct = (t.exit_price - t.entry_price) / t.entry_price * 100;
      pctText   = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      pctChange = pct >= 0 ? 'pos' : 'neg';
    }

    tradesMap[t.id] = t;
    return `
    <div class="tc ${isWin ? 'tc-win' : isLoss ? 'tc-loss' : ''}" data-id="${t.id}">
      <div class="tc-body" onclick="openPanel('${t.id}')">
        <div class="tc-symbol-col">
          <div class="tc-icon ${sideClass}">${iconChar}</div>
          <div class="tc-symbol-info">
            <div class="tc-symbol">${t.symbol}${t.notes || t.setup_tag ? ' <span class="row-dot"></span>' : ''}</div>
            <div class="tc-exchange">${t.exchange || ''}${t.session ? ' · ' + t.session : ''}</div>
          </div>
        </div>
        <div class="tc-side-col">
          <span class="tc-arrow ${sideClass}">${sideArrow}</span>
          <span class="tc-side-label ${sideClass}">${sideLabel}</span>
        </div>
        <div class="tc-times-col">
          <span>${fmtShortDate(t.entry_time)}</span>
          <span class="tc-time-sep">→</span>
          <span>${t.exit_time ? fmtShortDate(t.exit_time) : '—'}</span>
        </div>
        <div class="tc-prices-col">
          <span class="tc-price">${fmtNum(t.entry_price, 2)} → ${t.exit_price != null ? fmtNum(t.exit_price, 2) : '—'}</span>
          <span class="tc-price-change ${pctChange}">${pctText}</span>
        </div>
        <div class="tc-pnl-col">
          <span class="tc-pnl-badge ${pnlClass}">${fmtPnl(t.pnl)} USDT</span>
        </div>
        <div class="tc-duration-col">${fmtHoldTime(t.entry_time, t.exit_time)}</div>
        <div class="tc-chevron">›</div>
      </div>
      <div class="tc-detail" style="display:none"></div>
    </div>`;
  }).join('');
}

// ── Inline expand ─────────────────────────────────────────────────────────────
window.openPanel = function(id) {
  const t = tradesMap[id];
  if (!t) return;

  const card = document.querySelector(`.tc[data-id="${id}"]`);
  if (!card) return;

  const isOpen = card.classList.contains('open');

  document.querySelectorAll('.tc.open').forEach(c => {
    c.classList.remove('open');
    const d = c.querySelector('.tc-detail');
    if (d) { d.style.display = 'none'; d.innerHTML = ''; }
  });
  currentTrade = null;

  if (isOpen) return;

  currentTrade = t;
  card.classList.add('open');
  const detail = card.querySelector('.tc-detail');
  detail.style.display = 'block';

  // Init state
  currentTags = t.setup_tag ? t.setup_tag.split(',').map(s => s.trim()).filter(Boolean) : [];
  try { currentScreenshots = JSON.parse(t.strategy_tag || '[]'); } catch { currentScreenshots = []; }
  if (!Array.isArray(currentScreenshots)) currentScreenshots = [];

  const pnlClass = t.pnl > 0 ? 'pnl-pos' : t.pnl < 0 ? 'pnl-neg' : '';
  detail.innerHTML = `
    <div class="td-stats-row">
      <div class="td-stat"><div class="td-stat-label">Entry</div><div class="td-stat-val">${fmtNum(t.entry_price, 4)}</div></div>
      <div class="td-stat"><div class="td-stat-label">Exit</div><div class="td-stat-val">${t.exit_price != null ? fmtNum(t.exit_price, 4) : '—'}</div></div>
      <div class="td-stat"><div class="td-stat-label">Size</div><div class="td-stat-val">${fmtNum(t.size, 4)}</div></div>
      <div class="td-stat"><div class="td-stat-label">PnL</div><div class="td-stat-val ${pnlClass}">${fmtPnl(t.pnl)} USDT</div></div>
      <div class="td-stat"><div class="td-stat-label">Duración</div><div class="td-stat-val">${fmtHoldTime(t.entry_time, t.exit_time)}</div></div>
      <div class="td-stat"><div class="td-stat-label">Sesión</div><div class="td-stat-val">${t.session || '—'}</div></div>
    </div>
    <div class="td-divider"></div>
    <div class="td-main-grid">

      <!-- Tags + Emotion -->
      <div class="td-col">
        <div class="td-section-title">Tags</div>
        <div class="td-chips" id="tagChips"></div>
        <div class="td-input-row">
          <input type="text" id="tagInput" class="td-text-input" placeholder="Add tag…"
            onkeydown="if(event.key==='Enter'){event.preventDefault();addTag()}">
          <button class="td-add-btn" onclick="addTag()">+</button>
        </div>
        <div class="td-section-title" style="margin-top:16px">Emoción</div>
        <div class="tag-grid" id="tagEmotion"></div>
      </div>

      <!-- Notes -->
      <div class="td-col">
        <div class="td-section-title">Notes</div>
        <textarea id="panelNotes" class="panel-textarea td-notes-area" placeholder="Type your notes here…"></textarea>
      </div>

      <!-- Screenshots -->
      <div class="td-col">
        <div class="td-section-title">Screenshots</div>
        <div class="td-section-hint">Paste a TradingView, Gyazo or Imgur link</div>
        <div class="td-input-row" style="margin-bottom:10px">
          <input type="text" id="screenshotInput" class="td-text-input" placeholder="https://…"
            onkeydown="if(event.key==='Enter'){event.preventDefault();addScreenshot()}">
          <button class="td-add-btn" onclick="addScreenshot()">+</button>
        </div>
        <div class="td-screenshot-grid" id="screenshotGrid"></div>
      </div>

    </div>
    <div class="td-divider"></div>
    <div class="td-footer-row">
      <div>
        <div class="td-section-title" style="margin-bottom:8px">Rule Score</div>
        <div class="rule-score-row" id="ruleScoreRow"></div>
      </div>
      <button class="btn btn-accent" onclick="savePanel()">Guardar</button>
    </div>`;

  renderChips();
  renderScreenshots();
  renderEmotionGrid(t.emotion);
  renderRuleScore(t.rule_score);
  $('panelNotes').value = t.notes || '';

  requestAnimationFrame(() => detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
};

window.closePanel = function() {
  document.querySelectorAll('.tc.open').forEach(c => {
    c.classList.remove('open');
    const d = c.querySelector('.tc-detail');
    if (d) { d.style.display = 'none'; d.innerHTML = ''; }
  });
  currentTrade = null;
};

// ── Tag chips ──────────────────────────────────────────────────────────────────
function renderChips() {
  const el = $('tagChips');
  if (!el) return;
  el.innerHTML = currentTags.map((tag, i) =>
    `<span class="td-chip">${tag}<button class="td-chip-remove" onclick="removeTag(${i})">×</button></span>`
  ).join('');
}

window.addTag = function() {
  const input = $('tagInput');
  const val = input.value.trim().toUpperCase();
  if (!val || currentTags.includes(val)) { input.value = ''; return; }
  currentTags.push(val);
  input.value = '';
  renderChips();
};

window.removeTag = function(i) {
  currentTags.splice(i, 1);
  renderChips();
};

// ── Screenshots ────────────────────────────────────────────────────────────────
function renderScreenshots() {
  const el = $('screenshotGrid');
  if (!el) return;
  el.innerHTML = currentScreenshots.map((url, i) => `
    <div class="td-screenshot">
      <img src="${url}" alt="screenshot" style="cursor:zoom-in"
        onclick="event.stopPropagation();openLightbox('${url.replace(/'/g,"\\\'")}')"
        onerror="this.parentElement.querySelector('.td-ss-err').style.display='flex';this.style.display='none'">
      <div class="td-ss-err" style="display:none">${url.length > 40 ? url.slice(0,40)+'…' : url}</div>
      <button class="td-screenshot-remove" onclick="removeScreenshot(${i})">×</button>
    </div>`).join('');
}

window.openLightbox = function(url) {
  document.getElementById('td-lightbox')?.remove();
  const lb = document.createElement('div');
  lb.id = 'td-lightbox';
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:500;cursor:zoom-out';
  lb.innerHTML = `
    <img src="${url}" alt="" style="max-width:90vw;max-height:88vh;object-fit:contain;border-radius:8px;box-shadow:0 20px 80px rgba(0,0,0,0.8);cursor:default" onclick="event.stopPropagation()">
    <button style="position:absolute;top:16px;right:20px;background:none;border:none;color:rgba(255,255,255,0.7);font-size:32px;cursor:pointer;line-height:1" onclick="document.getElementById('td-lightbox').remove()">×</button>`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
};

window.addScreenshot = function() {
  const input = $('screenshotInput');
  const url = input.value.trim();
  if (!url) return;
  currentScreenshots.push(url);
  input.value = '';
  renderScreenshots();
};

window.removeScreenshot = function(i) {
  currentScreenshots.splice(i, 1);
  renderScreenshots();
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

  const emotionBtn = document.querySelector(`.tag-pill.active[data-type="emotion"]`);
  const scoreBtnActive = $('ruleScoreRow').querySelector('.score-btn.active');

  const body = {
    setup_tag:    currentTags.join(',') || null,
    strategy_tag: currentScreenshots.length ? JSON.stringify(currentScreenshots) : null,
    emotion:      emotionBtn ? (emotionBtn.dataset.val || null) : null,
    rule_score:   scoreBtnActive ? parseInt(scoreBtnActive.textContent) : null,
    notes:        $('panelNotes').value.trim() || null,
  };

  try {
    await updateTrade(currentTrade.id, body);
    toast('Trade actualizado');
    currentTrade = { ...currentTrade, ...body };
    // Update cache so re-opening shows latest data
    tradesMap[currentTrade.id] = currentTrade;
    load();
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('td-lightbox')?.remove();
    closePanel();
  }
});

load();
