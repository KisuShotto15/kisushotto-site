import { getTrades, createTrade, updateTrade, deleteTrade, getSetups, getStrategies } from './api.js';

const $ = id => document.getElementById(id);
let page = 0;
let editingId = null;
let filterDebounce = null;

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
  $('tradesBody').innerHTML = `<tr><td colspan="13"><div class="loading">Cargando…</div></td></tr>`;
  try {
    const { trades } = await getTrades(getFilters());
    renderTable(trades);
    $('pageInfo').textContent = `Página ${page + 1}`;
    $('btnPrev').disabled = page === 0;

    // Mini summary
    const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const wins = closed.filter(t => t.pnl > 0);
    $('miniSummary').innerHTML = [
      `<span>${trades.length} trades</span>`,
      closed.length ? `<span class="${totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDT</span>` : '',
      closed.length ? `<span>${Math.round(wins.length / closed.length * 100)}% win</span>` : '',
    ].join('<span style="color:var(--border2)"> · </span>');
  } catch (err) {
    $('tradesBody').innerHTML = `<tr><td colspan="13" style="color:var(--red);font-family:'IBM Plex Mono',monospace;font-size:12px;padding:16px">${err.message}</td></tr>`;
    toast(err.message, 'err');
  }
}

function renderTable(trades) {
  if (!trades.length) {
    $('tradesBody').innerHTML = `<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">📭</div>Sin trades con estos filtros</div></td></tr>`;
    return;
  }
  $('tradesBody').innerHTML = trades.map((t, i) => {
    const pnlClass = t.pnl > 0 ? 'pnl-pos' : t.pnl < 0 ? 'pnl-neg' : '';
    const sideClass = `side-${t.side}`;
    return `
    <tr>
      <td class="td-muted">${page * 50 + i + 1}</td>
      <td style="font-weight:600">${t.symbol}</td>
      <td class="${sideClass}">${t.side.toUpperCase()}</td>
      <td>${fmtNum(t.entry_price, 4)}</td>
      <td class="td-muted">${t.exit_price != null ? fmtNum(t.exit_price, 4) : '—'}</td>
      <td>${fmtNum(t.size, 4)}</td>
      <td class="${pnlClass}">${fmtPnl(t.pnl)}</td>
      <td class="td-muted">${t.fees ? fmtNum(t.fees, 4) : '—'}</td>
      <td class="td-muted">${t.session || '—'}</td>
      <td>${t.setup_tag ? `<span class="td-tag">${t.setup_tag}</span>` : '<span class="td-muted">—</span>'}</td>
      <td>${t.strategy_tag ? `<span class="td-tag">${t.strategy_tag}</span>` : '<span class="td-muted">—</span>'}</td>
      <td class="td-muted" style="max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${t.notes || ''}">${t.notes || '—'}</td>
      <td>
        <button class="btn-icon" onclick="openEditTrade(${JSON.stringify(t).replace(/"/g,'&quot;')})" title="Editar">✏</button>
        <button class="btn-icon" onclick="confirmDelete('${t.id}')" title="Eliminar">🗑</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Add/Edit modal ────────────────────────────────────────────────────────────
window.openAddTrade = function() {
  editingId = null;
  $('tradeModalTitle').textContent = 'Agregar trade';
  ['fmSymbol','fmEntry','fmExit','fmSize','fmPnl','fmFees','fmRule','fmSetup','fmStrategy','fmNotes'].forEach(id => { $(id).value = ''; });
  $('fmExchange').value = 'bybit';
  $('fmCategory').value = 'linear';
  $('fmSide').value = 'long';
  $('fmSession').value = 'ny';
  $('fmEmotion').value = '';
  $('fmExecType').value = 'manual';
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $('fmEntryTime').value = local;
  $('fmExitTime').value = '';
  $('tradeModal').classList.remove('hidden');
  $('fmSymbol').focus();
};

window.openEditTrade = function(t) {
  editingId = t.id;
  $('tradeModalTitle').textContent = 'Editar trade';
  $('fmSymbol').value   = t.symbol;
  $('fmExchange').value = t.exchange || 'bybit';
  $('fmCategory').value = t.category || 'linear';
  $('fmSide').value     = t.side;
  $('fmSession').value  = t.session || 'ny';
  $('fmEntry').value    = t.entry_price;
  $('fmExit').value     = t.exit_price ?? '';
  $('fmSize').value     = t.size;
  $('fmPnl').value      = t.pnl ?? '';
  $('fmFees').value     = t.fees ?? '';
  $('fmRule').value     = t.rule_score ?? '';
  $('fmSetup').value    = t.setup_tag ?? '';
  $('fmStrategy').value = t.strategy_tag ?? '';
  $('fmEmotion').value  = t.emotion ?? '';
  $('fmExecType').value = t.exec_type || 'manual';
  $('fmNotes').value    = t.notes ?? '';
  const toLocal = ts => ts ? new Date(ts * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  $('fmEntryTime').value = toLocal(t.entry_time);
  $('fmExitTime').value  = toLocal(t.exit_time);
  $('tradeModal').classList.remove('hidden');
};

window.closeTradeModal = function() {
  $('tradeModal').classList.add('hidden');
  editingId = null;
};

window.saveTrade = async function() {
  const toUnix = v => v ? Math.floor(new Date(v).getTime() / 1000) : null;
  const body = {
    symbol:       $('fmSymbol').value.trim().toUpperCase(),
    exchange:     $('fmExchange').value,
    category:     $('fmCategory').value,
    side:         $('fmSide').value,
    session:      $('fmSession').value,
    entry_price:  parseFloat($('fmEntry').value) || 0,
    exit_price:   $('fmExit').value   ? parseFloat($('fmExit').value)   : null,
    size:         parseFloat($('fmSize').value) || 0,
    pnl:          $('fmPnl').value    ? parseFloat($('fmPnl').value)    : null,
    fees:         $('fmFees').value   ? parseFloat($('fmFees').value)   : 0,
    rule_score:   $('fmRule').value   ? parseInt($('fmRule').value)     : null,
    entry_time:   toUnix($('fmEntryTime').value),
    exit_time:    toUnix($('fmExitTime').value),
    setup_tag:    $('fmSetup').value.trim()    || null,
    strategy_tag: $('fmStrategy').value.trim() || null,
    emotion:      $('fmEmotion').value || null,
    exec_type:    $('fmExecType').value,
    notes:        $('fmNotes').value.trim() || null,
  };
  if (!body.symbol) { toast('Símbolo requerido', 'err'); return; }
  try {
    if (editingId) await updateTrade(editingId, body);
    else           await createTrade(body);
    toast(editingId ? 'Trade actualizado' : 'Trade creado');
    closeTradeModal();
    load();
  } catch (err) {
    toast(err.message, 'err');
  }
};

window.confirmDelete = async function(id) {
  if (!confirm('¿Eliminar este trade?')) return;
  try {
    await deleteTrade(id);
    toast('Trade eliminado');
    load();
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ── Datalists ─────────────────────────────────────────────────────────────────
async function loadTagLists() {
  try {
    const [s, st] = await Promise.all([getSetups(), getStrategies()]);
    $('setupsList').innerHTML = (s.setups || []).map(x => `<option value="${x.name}">`).join('');
    $('strategiesList').innerHTML = (st.strategies || []).map(x => `<option value="${x.name}">`).join('');
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTradeModal();
});
document.addEventListener('click', e => {
  if (e.target.id === 'tradeModal') closeTradeModal();
});

Promise.all([load(), loadTagLists()]);
