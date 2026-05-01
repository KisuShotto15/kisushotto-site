// notes/main.js — init, render, view state, event handlers.

import * as idb from './idb.js';
import {
  apiGetMe, apiCreateCat, apiUpdateCat, apiDeleteCat,
  apiShareNote, apiRevokeShare,
  apiUploadAttachment, apiDeleteAttachment, apiAttachmentBlobUrl,
  apiTrashNote, apiRestoreNote, apiPurgeNote,
  getUserEmail,
} from './api.js';
import { pull, flushQueue, saveNoteLocal, saveCategoryLocal, onConnectionChange } from './sync.js';
import {
  isSessionUnlocked, lockSession,
  setPin, verifyPin,
  isWebauthnAvailable, registerWebauthn, unlockWithWebauthn,
} from './auth.js';
import { startRecording, stopRecording, cancelRecording, isRecording } from './recorder.js';
import { ensurePushSubscription } from './push.js';

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

window.customConfirm = function(msg, okText = 'Eliminar', cancelText = 'Cancelar') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    const bg = document.getElementById('confirm-bg');
    
    msgEl.textContent = msg;
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;

    modal.hidden = false;
    
    function cleanup() {
      modal.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      bg.onclick = null;
    }
    
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
    bg.onclick = () => { cleanup(); resolve(false); };
  });
};

const State = {
  user: null,
  notes: [],
  categories: [],
  view: 'all',          // 'all' | 'archive' | 'trash' | 'shared' | 'locked' | 'cat:<id>'
  search: '',
  editing: null,        // note being edited
  editorDirty: false,   // whether note was modified while editor was open
  attachUrls: {},       // attId -> object URL
  pinPending: null,     // resolver fn while PIN modal open
  selected: new Set(),  // selected note IDs for multi-select
  selectMode: false,
};

let saveTimer = null;

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!getUserEmail()) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center"><h2>No estás autenticado</h2><p>Abre la app desde el dominio protegido.</p></div>';
    return;
  }

  // ── BIND UI FIRST — must run before any async that can throw ──────────
  // This guarantees buttons/modals always respond even if IDB or network fails
  // (Brave Shields can block IndexedDB, breaking all async below)
  bindUI();

  // SW
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }

  // Online indicator
  updateNetBanner(navigator.onLine);
  onConnectionChange(updateNetBanner);

  // Local-first — wrapped in try/catch because IDB may be blocked (Brave Shields)
  try {
    await loadFromIDB();
    render();
  } catch (e) {
    console.warn('IndexedDB load failed (Brave Shields?)', e);
    render(); // render empty state so the UI is usable
  }

  // Network
  try {
    State.user = await apiGetMe();
    await pull();
    await loadFromIDB();
    render();
  } catch (e) {
    console.warn('initial sync failed', e);
  }

  // Periodic pull — only re-render if server returned new/updated data
  setInterval(async () => {
    if (!navigator.onLine) return;
    try {
      const { changed } = await pull();
      if (changed && $('#editor').hidden) { await loadFromIDB(); render(); }
    } catch {}
  }, 30000);

  // Open note from query param (push notification deep-link)
  const params = new URLSearchParams(location.search);
  const wantId = params.get('note');
  if (wantId) {
    const n = State.notes.find(x => x.id === wantId);
    if (n) openEditor(n);
  }
}

async function loadFromIDB() {
  State.notes      = await idb.getAll('notes')      || [];
  State.categories = await idb.getAll('categories') || [];
  State.notes.sort((a, b) => (b.last_modified || 0) - (a.last_modified || 0));
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}
function closeLightbox() { $('#lightbox').hidden = true; }

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
  // On mobile, ensure textarea stays scrollable when it exceeds viewport
  if (window.innerWidth <= 640) {
    el.style.overflow = 'auto';
  }
}

function isMobile() { return window.innerWidth <= 640; }

function lockBodyScroll() {
  const scrollY = window.scrollY;
  document.body.style.setProperty('--scroll-y', `-${scrollY}px`);
  document.body.classList.add('modal-open');
  document.body.dataset.scrollY = scrollY;
}

function unlockBodyScroll() {
  const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('--scroll-y');
  window.scrollTo(0, scrollY);
}

function placeCursorAtEnd(el) {
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function updateNetBanner(online) {
  const el = $('#net-banner');
  if (!el) return;
  el.hidden = !!online;
}

// ── render ───────────────────────────────────────────────────────────────────
function getCurrentNotes() {
  const v = State.view;
  const q = State.search.trim().toLowerCase();
  const me = getUserEmail();

  return State.notes.filter(n => {
    if (v === 'trash')   return !!n.trashed_at;
    if (n.trashed_at)    return false;
    if (v === 'archive') return !!n.archived;
    if (n.archived)      return false;
    if (v === 'shared')  return n.owner_email !== me || (n.shares?.length > 0);
    if (v === 'locked')  return !!n.locked;
    if (v.startsWith('cat:')) {
      const id = v.slice(4);
      return (n.categories || []).includes(id);
    }
    // 'all'
    return true;
  }).filter(n => {
    if (!q) return true;
    const hay = (
      (n.title || '') + ' ' +
      (n.body || '') + ' ' +
      (n.checklist_items || []).map(c => c.text).join(' ')
    ).toLowerCase();
    return hay.includes(q);
  });
}

function renderCategoriesStrip() { renderSidebarNav(); }

function renderSidebarNav() {
  const list = $('#sidebar-cat-list');
  if (!list) return;
  const me = getUserEmail();
  const ownCats = State.categories.filter(c => c.owner_email === me)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  list.innerHTML = ownCats.map(c => `
    <button class="sidebar-item${State.view === 'cat:' + c.id ? ' active' : ''}" data-view="cat:${c.id}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path></svg>
      <span>${escapeHtml(c.name)}</span>
    </button>
  `).join('');

  list.querySelectorAll('.sidebar-item').forEach(btn => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
      if (window.innerWidth < 900) closeSidebar();
    });
  });

  updateSidebarActive();
}

function updateSidebarActive() {
  $$('.sidebar-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === State.view);
  });
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  $('#sidebar-backdrop').style.display = 'block';
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
  $('#sidebar-backdrop').style.display = 'none';
}

async function reorderCategory(id, dir) {
  const me = getUserEmail();
  const cats = State.categories.filter(c => c.owner_email === me)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const idx = cats.findIndex(c => c.id === id);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= cats.length) return;
  [cats[idx].sort_order, cats[swapIdx].sort_order] = [swapIdx, idx];
  cats[idx].updated_at = Date.now();
  cats[swapIdx].updated_at = Date.now();
  await saveCategoryLocal(cats[idx]);
  await saveCategoryLocal(cats[swapIdx]);
  renderCategoriesStrip();
  renderDrawerCats();
}

function renderDrawerCats() {
  const root = $('#drawer-cat-list');
  if (!root) return;
  root.innerHTML = '';
  const me = getUserEmail();
  const own = State.categories.filter(c => c.owner_email === me)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const c of own) {
    const row = document.createElement('div');
    row.className = 'drawer-cat-row';
    row.innerHTML = `
      <span class="drawer-cat-dot" style="background:${c.color}"></span>
      <input class="drawer-cat-name" value="${escapeHtml(c.name)}" data-id="${c.id}">
      <input type="color" value="${c.color}" data-id="${c.id}" data-field="color">
      <button class="btn-icon cat-up" data-id="${c.id}" title="Subir">↑</button>
      <button class="btn-icon cat-dn" data-id="${c.id}" title="Bajar">↓</button>
      <button class="btn-icon" data-del="${c.id}">🗑️</button>
    `;
    root.appendChild(row);
  }
  root.querySelectorAll('.drawer-cat-name').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const cat = State.categories.find(c => c.id === id);
      if (!cat) return;
      cat.name = e.target.value.trim() || cat.name;
      cat.updated_at = Date.now();
      await saveCategoryLocal(cat);
      try { await apiUpdateCat(id, { name: cat.name }); } catch {}
      renderCategoriesStrip();
    });
  });
  root.querySelectorAll('input[type=color]').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const cat = State.categories.find(c => c.id === id);
      if (!cat) return;
      cat.color = e.target.value;
      cat.updated_at = Date.now();
      await saveCategoryLocal(cat);
      try { await apiUpdateCat(id, { color: cat.color }); } catch {}
      renderCategoriesStrip();
    });
  });
  root.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.del;
      if (!(await window.customConfirm('¿Eliminar categoría? Las notas no se borran.'))) return;
      try { await apiDeleteCat(id); } catch {}
      State.categories = State.categories.filter(c => c.id !== id);
      await idb.del('categories', id);
      renderCategoriesStrip();
      renderDrawerCats();
      render();
    });
  });
  root.querySelectorAll('button.cat-up').forEach(btn => {
    btn.addEventListener('click', (e) => reorderCategory(e.currentTarget.dataset.id, -1));
  });
  root.querySelectorAll('button.cat-dn').forEach(btn => {
    btn.addEventListener('click', (e) => reorderCategory(e.currentTarget.dataset.id, +1));
  });
}

function noteCardHtml(n) {
  const me = getUserEmail();
  const isShared = n.owner_email !== me;
  const colored = !!n.color;
  const isSelected = State.selected.has(n.id);
  const cls = `note-card${colored ? ' colored' : ''}${isSelected ? ' selected' : ''}`;
  const style = colored ? `style="background:${n.color}"` : '';
  let body = '';
  if (n.locked && !isSessionUnlocked()) {
    body = `<div class="nc-body" style="display:flex;align-items:center;gap:8px;color:var(--muted)"><span class="nc-locked"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span> Nota protegida</div>`;
  } else if (n.type === 'checklist') {
    const items = (n.checklist_items || []).slice(0, 8);
    body = `<div class="nc-body">` + items.map((it, idx) =>
      `<div class="nc-checklist-line ${it.done ? 'done' : ''}" data-idx="${idx}"><input type="checkbox" ${it.done ? 'checked' : ''}> ${escapeHtml(it.text || '')}</div>`
    ).join('') + (items.length < (n.checklist_items?.length || 0) ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">+${(n.checklist_items?.length || 0) - items.length} más</div>` : '') + `</div>`;
  } else {
    body = `<div class="nc-body">${escapeHtml(n.body || '').slice(0, 600)}</div>`;
  }

  let imgs = '';
  if (n.attachments?.length) {
    const firstImg = n.attachments.find(a => a.type === 'image');
    if (firstImg) imgs += `<img class="nc-image-thumb" data-att="${firstImg.id}" alt="" loading="lazy">`;
    const audios = n.attachments.filter(a => a.type === 'audio');
    for (const a of audios) imgs += `<audio class="nc-audio" controls preload="none" data-att="${a.id}"></audio>`;
  }

  const cats = (n.categories || []).map(cid => State.categories.find(c => c.id === cid)).filter(Boolean);
  const catTags = cats.map(c => `<span class="nc-cat-tag">${escapeHtml(c.name)}</span>`).join('');
  const sharedBadge = isShared ? `<span class="nc-shared">📥 Compartida</span>` : '';
  const lockBadge = n.locked ? `<span class="nc-locked" style="display:inline-flex;align-items:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span>` : '';
  const reminderBadge = n.reminder_at ? `<span>⏰ ${fmtDate(n.reminder_at)}</span>` : '';

  return `
    <article class="${cls}" ${style} data-id="${n.id}" onclick="">
      <label class="nc-select-wrap"><input type="checkbox" class="nc-select-cb" data-id="${n.id}" ${isSelected ? 'checked' : ''}></label>
      ${n.pinned ? '<span class="nc-pin"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></span>' : ''}
      ${n.locked && !isSessionUnlocked() ? '' : (n.title ? `<div class="nc-title">${escapeHtml(n.title)}</div>` : '')}
      ${n.locked && !isSessionUnlocked() ? '' : imgs}
      ${body}
      <div class="nc-meta">${catTags}${sharedBadge}${lockBadge}${reminderBadge}</div>
    </article>
  `;
}

function cardHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

let _lpTimer = null;
function wireCard(card) {
  card.addEventListener('touchstart', () => {
    _lpTimer = setTimeout(() => { enterSelectMode(); toggleSelect(card.dataset.id); }, 550);
  }, { passive: true });
  card.addEventListener('touchend',  () => clearTimeout(_lpTimer));
  card.addEventListener('touchmove', () => clearTimeout(_lpTimer));
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('.nc-select-wrap')) {
      ev.stopPropagation();
      if (!State.selectMode) enterSelectMode();
      toggleSelect(card.dataset.id);
      return;
    }
    if (State.selectMode) {
      toggleSelect(card.dataset.id);
      if (State.selected.size === 0) exitSelectMode();
      return;
    }
    if (ev.target.matches('.nc-checklist-line input[type="checkbox"]')) {
      ev.stopPropagation();
      const chkLine = ev.target.closest('.nc-checklist-line');
      if (!chkLine) return;
      const n = State.notes.find(x => x.id === card.dataset.id);
      if (!n || !n.checklist_items) return;
      const idx = parseInt(chkLine.dataset.idx, 10);
      const item = n.checklist_items[idx];
      if (!item) return;
      item.done = !item.done;
      n.last_modified = Date.now();
      saveNoteLocal(n);
      chkLine.classList.toggle('done', item.done);
      ev.target.checked = item.done;
      return;
    }
    const n = State.notes.find(x => x.id === card.dataset.id);
    if (n) openCard(n);
  });
}

function patchGrid(container, notes) {
  const existing = new Map();
  container.querySelectorAll('.note-card').forEach(el => existing.set(el.dataset.id, el));

  const newIds = new Set(notes.map(n => n.id));
  existing.forEach((el, id) => { if (!newIds.has(id)) el.remove(); });

  notes.forEach((n, i) => {
    const html = noteCardHtml(n);
    const h = String(cardHash(html));
    let el = existing.get(n.id);

    if (el) {
      if (el.dataset.rh !== h) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html.trim();
        const newEl = tmp.firstElementChild;
        newEl.dataset.rh = h;
        newEl.style.animation = 'none';
        el.replaceWith(newEl);
        wireCard(newEl);
        existing.set(n.id, newEl);
        el = newEl;
      }
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = html.trim();
      el = tmp.firstElementChild;
      el.dataset.rh = h;
      wireCard(el);
      existing.set(n.id, el);
    }

    // Ensure correct DOM order
    const children = container.children;
    if (children[i] !== el) container.insertBefore(el, children[i] || null);
  });

  // Restore attachment srcs (only on cards that are already in DOM)
  container.querySelectorAll('img.nc-image-thumb[data-att]').forEach(async img => {
    const id = img.dataset.att;
    if (!id || img.getAttribute('src')) return;
    if (State.attachUrls[id]) { img.src = State.attachUrls[id]; return; }
    try { const url = await apiAttachmentBlobUrl(id); State.attachUrls[id] = url; img.src = url; } catch {}
  });
  container.querySelectorAll('audio.nc-audio[data-att]').forEach(async audio => {
    const id = audio.dataset.att;
    if (!id || audio.getAttribute('src')) return;
    if (State.attachUrls[id]) { audio.src = State.attachUrls[id]; return; }
    try { const url = await apiAttachmentBlobUrl(id); State.attachUrls[id] = url; audio.src = url; } catch {}
  });
}

function renderGrid() {
  const notes = getCurrentNotes();
  const pinned = notes.filter(n => n.pinned);
  const others = notes.filter(n => !n.pinned);

  $('#pinned-section').hidden = pinned.length === 0 || State.view === 'trash';
  patchGrid($('#grid-pinned'), pinned);
  patchGrid($('#grid-others'), others);

  const titleMap = {
    all: 'Notas', archive: 'Archivo', trash: 'Papelera',
    shared: 'Compartidas conmigo', locked: 'Protegidas',
  };
  let title = titleMap[State.view] || 'Notas';
  if (State.view.startsWith('cat:')) {
    const c = State.categories.find(c => c.id === State.view.slice(4));
    title = c?.name || 'Categoría';
  }
  $('#others-title').textContent = title;
  $('#empty-state').hidden = !!notes.length;
}

function render() {
  renderCategoriesStrip();
  renderDrawerCats();
  renderGrid();
}

// ── multi-select ─────────────────────────────────────────────────────────────
function enterSelectMode() {
  State.selectMode = true;
  document.body.classList.add('select-mode');
  updateSelectBar();
}

function exitSelectMode() {
  State.selectMode = false;
  State.selected.clear();
  document.body.classList.remove('select-mode');
  $$('.note-card').forEach(c => c.classList.remove('selected'));
  const bar = $('#select-bar');
  if (bar) bar.hidden = true;
}

function toggleSelect(id) {
  if (State.selected.has(id)) State.selected.delete(id);
  else State.selected.add(id);
  const isNow = State.selected.has(id);
  const card = $(`.note-card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', isNow);
    const cb = card.querySelector('.nc-select-cb');
    if (cb) cb.checked = isNow;
  }
  updateSelectBar();
}

function updateSelectBar() {
  const bar = $('#select-bar');
  const count = $('#select-count');
  if (!bar) return;
  if (State.selected.size === 0 && State.selectMode) {
    bar.hidden = true;
    return;
  }
  bar.hidden = !State.selectMode;
  if (count) count.textContent = `${State.selected.size} seleccionada${State.selected.size !== 1 ? 's' : ''}`;
}

// ── view state ───────────────────────────────────────────────────────────────
function setView(v) {
  if (State.selectMode) exitSelectMode();
  State.view = v;
  updateSidebarActive();
  render();
}

// ── card click → editor or PIN ───────────────────────────────────────────────
async function openCard(n) {
  if (n.locked && !isSessionUnlocked()) {
    const ok = await promptUnlock();
    if (!ok) return;
  }
  openEditor(n);
}

// ── editor ───────────────────────────────────────────────────────────────────
function openEditor(n) {
  State.editing = JSON.parse(JSON.stringify(n));
  const e = State.editing;

  // Push history entry so Android back button closes editor instead of exiting
  history.pushState({ modal: 'editor' }, '');

  lockBodyScroll();
  $('#editor').hidden = false;
  const card = $('#editor .editor-card');
  card.style.background = e.color || '';
  card.classList.toggle('colored', !!e.color);
  $('#ed-title').value = e.title || '';
  $('#ed-body').value  = e.body || '';
  autoGrow($('#ed-body'));
  const isChecklist = e.type === 'checklist';
  $('#ed-body').hidden = isChecklist;
  $('#ed-checklist-list').hidden = !isChecklist;

  renderChecklist();
  renderAttachments();
  updateEditorMeta();
  $('#ed-status').textContent = '';

  setTimeout(() => {
    // On mobile, don't auto-focus to avoid keyboard popping up immediately
    if (!isMobile()) $('#ed-title').focus();
  }, 50);
}

function updateEditorMeta() {
  const e = State.editing;
  if (!e) return;
  const tags = [];
  // if (e.pinned)      tags.push('<span class="ed-meta-tag">📌 Fijada</span>');
  if (e.locked)      tags.push('<span class="ed-meta-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Protegida</span>');
  if (e.archived)    tags.push('<span class="ed-meta-tag">📦 Archivada</span>');
  if (e.reminder_at) tags.push(`<span class="ed-meta-tag">⏰ ${fmtDate(e.reminder_at)}</span>`);
  if (e.shares?.length) tags.push(`<span class="ed-meta-tag shared">👥 ${e.shares.length} compartido(s)</span>`);
  if (e.color)       tags.push(`<span class="ed-meta-tag" style="background:${e.color};color:var(--text)">🎨</span>`);
  for (const cid of (e.categories || [])) {
    const c = State.categories.find(x => x.id === cid);
    if (c) tags.push(`<span class="ed-meta-tag" style="border-color:${c.color}">${escapeHtml(c.name)}</span>`);
  }
  $('#ed-meta').innerHTML = tags.join('');

  // Active states on toolbar buttons
  const btn = id => document.getElementById(id);
  btn('ed-pin')?.classList.toggle('active', !!e.pinned);
  btn('ed-lock')?.classList.toggle('active', !!e.locked);
  btn('ed-archive')?.classList.toggle('active', !!e.archived);
  btn('ed-reminder')?.classList.toggle('active', !!e.reminder_at);
  btn('ed-share')?.classList.toggle('active', !!(e.shares?.length));
  btn('ed-categories')?.classList.toggle('active', !!(e.categories?.length));
  const colorBtn = btn('ed-color');
  if (colorBtn) {
    colorBtn.classList.toggle('active', !!e.color);
    colorBtn.style.background = e.color || '';
  }
  btn('ed-checklist')?.classList.toggle('active', e.type === 'checklist');
}

function syncChecklistFromDom() {
  const root = $('#ed-checklist-list');
  const e = State.editing;
  if (!root || !e) return;
  root.querySelectorAll('.ed-check-row').forEach(row => {
    const id = row.dataset.id;
    const item = e.checklist_items?.find(x => x.id === id);
    if (item) {
      const txt = row.querySelector('.ed-check-text');
      if (txt) item.text = txt.innerText.replace(/\n$/, '');
    }
  });
}

function reorderChecklist(srcId, targetId) {
  const e = State.editing;
  if (!e) return;
  syncChecklistFromDom();
  const items = e.checklist_items;
  const srcIdx = items.findIndex(x => x.id === srcId);
  const tgtIdx = items.findIndex(x => x.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) return;
  const [moved] = items.splice(srcIdx, 1);
  items.splice(tgtIdx, 0, moved);
  renderChecklist();
  scheduleSave();
}

function renderChecklist() {
  const root = $('#ed-checklist-list');
  if (!root) return;
  root.innerHTML = '';
  const e = State.editing;
  if (!e) return;
  const items = e.checklist_items || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const row = document.createElement('div');
    row.className = `ed-check-row ${it.done ? 'done' : ''}`;
    row.dataset.id = it.id;
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.contentEditable = 'false';
    handle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = it.done;
    chk.contentEditable = 'false';

    const txt = document.createElement('div');
    txt.className = 'ed-check-text';
    txt.contentEditable = 'true';
    txt.spellcheck = true;
    txt.textContent = it.text || '';

    const del = document.createElement('button');
    del.className = 'btn-icon row-del';
    del.title = 'Eliminar';
    del.contentEditable = 'false';
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

    chk.addEventListener('change', () => { it.done = chk.checked; row.classList.toggle('done', chk.checked); scheduleSave(); });
    del.addEventListener('click', () => { e.checklist_items = e.checklist_items.filter(x => x.id !== it.id); renderChecklist(); scheduleSave(); });

    row.append(handle, chk, txt, del);
    root.appendChild(row);
  }

  // "Nuevo ítem" input row has been removed.

  // ── Drag-and-drop (mouse: only from handle; touch: handle touch events) ──
  let dragSrcId = null;

  root.querySelectorAll('.ed-check-row').forEach(row => {
    // Mouse drag — only activated when handle is grabbed
    row.addEventListener('dragstart', ev => {
      if (!row.draggable) { ev.preventDefault(); return; }
      dragSrcId = row.dataset.id;
      ev.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.draggable = false; });
    row.addEventListener('dragover', ev => {
      ev.preventDefault();
      root.querySelectorAll('.ed-check-row').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', ev => {
      ev.preventDefault();
      row.classList.remove('drag-over');
      if (dragSrcId && dragSrcId !== row.dataset.id) reorderChecklist(dragSrcId, row.dataset.id);
      dragSrcId = null;
    });
    // Enable drag only when mousedown is on the handle
    row.querySelector('.drag-handle')?.addEventListener('mousedown', () => {
      row.draggable = true;
    });
  });

  // Touch drag on handle
  root.querySelectorAll('.drag-handle').forEach(handle => {
    let touchDragId = null;
    handle.addEventListener('touchstart', ev => {
      touchDragId = handle.closest('.ed-check-row')?.dataset.id;
      ev.preventDefault();
    }, { passive: false });
    handle.addEventListener('touchmove', ev => {
      if (!touchDragId) return;
      ev.preventDefault();
      const touch = ev.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = el?.closest('.ed-check-row');
      root.querySelectorAll('.ed-check-row').forEach(r => r.classList.remove('drag-over'));
      if (targetRow && targetRow.dataset.id !== touchDragId) targetRow.classList.add('drag-over');
    }, { passive: false });
    handle.addEventListener('touchend', ev => {
      if (!touchDragId) return;
      const touch = ev.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = el?.closest('.ed-check-row');
      root.querySelectorAll('.ed-check-row').forEach(r => r.classList.remove('drag-over'));
      if (targetRow && targetRow.dataset.id !== touchDragId) reorderChecklist(touchDragId, targetRow.dataset.id);
      touchDragId = null;
    }, { passive: false });
  });
}

function renderAttachments() {
  const root = $('#ed-attachments');
  root.innerHTML = '';
  const e = State.editing;
  if (!e?.attachments) return;
  for (const a of e.attachments) {
    const div = document.createElement('div');
    div.className = 'ed-att';
    if (a.type === 'image') div.innerHTML = `<img data-att="${a.id}" alt=""><button class="ed-att-del" data-del="${a.id}">×</button>`;
    else                    div.innerHTML = `<audio data-att="${a.id}" controls></audio><button class="ed-att-del" data-del="${a.id}">×</button>`;
    root.appendChild(div);
  }
  // load blobs
  root.querySelectorAll('[data-att]').forEach(async el => {
    const id = el.dataset.att;
    if (State.attachUrls[id]) { el.src = State.attachUrls[id]; return; }
    try {
      const url = await apiAttachmentBlobUrl(id);
      State.attachUrls[id] = url;
      el.src = url;
    } catch {}
  });
  root.querySelectorAll('button[data-del]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.del;
      if (!(await window.customConfirm('¿Eliminar adjunto?'))) return;
      try { await apiDeleteAttachment(id); } catch {}
      e.attachments = e.attachments.filter(a => a.id !== id);
      e.last_modified = Date.now();
      await saveNoteLocal(e);
      const idx = State.notes.findIndex(n => n.id === e.id);
      if (idx >= 0) State.notes[idx] = e;
      renderAttachments();
    });
  });
}

function scheduleSave() {
  const e = State.editing;
  if (!e) return;
  e.title = $('#ed-title').value;
  e.body  = $('#ed-body').value;
  e.last_modified = Date.now();
  $('#ed-status').textContent = 'Escribiendo...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commitEditor, 800);
}

async function commitEditor() {
  const e = State.editing;
  if (!e) return;
  const idx = State.notes.findIndex(n => n.id === e.id);
  if (idx >= 0) State.notes[idx] = JSON.parse(JSON.stringify(e));
  else State.notes.unshift(JSON.parse(JSON.stringify(e)));
  await saveNoteLocal(e);
  State.editorDirty = true;
  $('#ed-status').textContent = 'Guardado';
  updateEditorMeta();
  if ($('#editor').hidden) renderGrid();
}

function isNoteEmpty(e) {
  if (!e) return true;
  if ((e.title || '').trim()) return false;
  if ((e.body || '').trim()) return false;
  if ((e.checklist_items || []).some(it => (it.text || '').trim())) return false;
  if ((e.attachments || []).length) return false;
  return true;
}

function closeEditor(fromPopState = false) {
  if (State.editing) {
    syncChecklistFromDom();
    const e = State.editing;
    e.title = $('#ed-title')?.value || '';
    e.body  = $('#ed-body')?.value  || '';
    if (isNoteEmpty(e)) {
      State.notes = State.notes.filter(n => n.id !== e.id);
      idb.del('notes', e.id).catch(() => {});
      renderGrid();
    } else {
      commitEditor();
    }
  }
  if (!fromPopState && history.state?.modal === 'editor') history.back();
  State.editing = null;
  unlockBodyScroll();
  hidePopups();

  const modal = $('#editor');
  modal.classList.add('closing');
  const card = modal.querySelector('.modal-card');
  card.addEventListener('animationend', () => {
    modal.classList.remove('closing');
    modal.hidden = true;
    $('#ed-checklist-list').contentEditable = 'inherit';
    if (State.editorDirty) { State.editorDirty = false; renderGrid(); }
  }, { once: true });
}

function openNew(type) {
  const me = getUserEmail();
  const n = {
    id: crypto.randomUUID(),
    owner_email: me,
    title: '',
    body: '',
    type: (type === 'checklist') ? 'checklist' : 'text',
    checklist_items: (type === 'checklist') ? [{ id: crypto.randomUUID(), text: '', done: false, order: 0 }] : [],
    color: null,
    pinned: false,
    archived: false,
    trashed_at: null,
    locked: false,
    reminder_at: null,
    reminder_sent: false,
    last_modified: Date.now(),
    created_at: Date.now(),
    categories: [],
    attachments: [],
    shares: [],
  };
  State.notes.unshift(n);
  saveNoteLocal(n);
  openEditor(n);
  // Trigger media immediately for audio/image shortcuts
  if (type === 'audio') setTimeout(() => $('#ed-audio')?.click(), 100);
  if (type === 'image') setTimeout(() => $('#ed-image')?.click(), 100);
}

// ── PIN unlock prompt ────────────────────────────────────────────────────────
async function promptUnlock() {
  return new Promise(async (resolve) => {
    State.pinPending = resolve;
    lockBodyScroll();
    const modal = $('#pin-modal');
    modal.hidden = false;
    $('#pin-input').value = '';
    setTimeout(() => $('#pin-input').focus(), 50);

    const bioBtn = $('#pin-biometric');
    if (await isWebauthnAvailable()) {
      bioBtn.hidden = false;
      // try silent biometric immediately
      try {
        const ok = await unlockWithWebauthn();
        if (ok) {
          modal.hidden = true;
          State.pinPending = null;
          unlockBodyScroll();
          resolve(true);
        }
      } catch {}
    } else {
      bioBtn.hidden = true;
    }
  });
}

function closePinModal(ok) {
  $('#pin-modal').hidden = true;
  unlockBodyScroll();
  if (State.pinPending) {
    State.pinPending(!!ok);
    State.pinPending = null;
  }
}

// ── action: pin / archive / lock / color / categories / share / reminder ────
function bindEditorActions() {
  $('#ed-pin').addEventListener('click', () => {
    State.editing.pinned = !State.editing.pinned;
    scheduleSave(); updateEditorMeta();
  });
  $('#ed-lock').addEventListener('click', () => {
    State.editing.locked = !State.editing.locked;
    scheduleSave(); updateEditorMeta();
  });
  $('#ed-archive').addEventListener('click', () => {
    State.editing.archived = !State.editing.archived;
    scheduleSave(); updateEditorMeta();
    closeEditor();
    render();
  });
  $('#ed-checklist').addEventListener('click', () => {
    const e = State.editing;
    if (e.type === 'checklist') {
      syncChecklistFromDom();
      const txt = (e.checklist_items || []).map(it => it.text).join('\n');
      e.body = txt;
      e.type = 'text';
      e.checklist_items = [];
      $('#ed-body').value = e.body;
      autoGrow($('#ed-body'));
    } else {
      // Sync textarea before converting so we don't lose unsaved text
      e.body = $('#ed-body').value;
      e.type = 'checklist';
      const lines = e.body.split('\n').filter(l => l.trim());
      if (lines.length) {
        e.checklist_items = lines.map(l => ({
          id: crypto.randomUUID(),
          text: l.replace(/^\[\s?[xX]?\s?\]\s*/, ''),
          done: /^\[\s?[xX]\s?\]/.test(l),
          order: 0,
        }));
      } else if (!e.checklist_items?.length) {
        e.checklist_items = [{ id: crypto.randomUUID(), text: '', done: false, order: 0 }];
      }
      e.body = '';
    }
    $('#ed-body').hidden = e.type === 'checklist';
    $('#ed-checklist-list').hidden = e.type !== 'checklist';
    hidePopups();
    renderChecklist();
    scheduleSave();
  });

  // More options menu (⋮)
  $('#ed-more').addEventListener('click', (ev) => {
    showPopupAt('#popup-more', ev.currentTarget);
  });

  // Add menu (+)
  $('#ed-add').addEventListener('click', (ev) => {
    showPopupAt('#popup-add', ev.currentTarget);
  });

  // Undo / redo
  $('#ed-undo').addEventListener('click', () => {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      document.execCommand('undo');
    } else {
      $('#ed-body').focus();
      document.execCommand('undo');
    }
  });
  $('#ed-redo').addEventListener('click', () => {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      document.execCommand('redo');
    } else {
      $('#ed-body').focus();
      document.execCommand('redo');
    }
  });
  $('#ed-delete').addEventListener('click', async () => {
    if (!(await window.customConfirm('¿Mover a la papelera?'))) return;
    const id = State.editing.id;
    State.editing.trashed_at = Date.now();
    State.editing.last_modified = Date.now();
    await commitEditor();
    try { await apiTrashNote(id); } catch {}
    closeEditor();
    render();
  });

  // Color picker
  $('#ed-color').addEventListener('click', (ev) => {
    showPopupAt('#popup-color', ev.currentTarget);
  });
  $$('#popup-color .color-swatch').forEach(s => {
    s.addEventListener('click', () => {
      State.editing.color = s.dataset.color || null;
      const c = State.editing.color;
      const ec = $('#editor .editor-card');
      ec.style.background = c || '';
      ec.classList.toggle('colored', !!c);
      hidePopups();
      scheduleSave();
      updateEditorMeta();
      // color change is already visible in the open editor — skip grid rebuild
    });
  });

  // Categories
  $('#ed-categories').addEventListener('click', (ev) => {
    renderCategoriesPopup();
    showPopupAt('#popup-cats', ev.currentTarget);
  });
  $('#popup-new-cat-btn').addEventListener('click', async () => {
    const inp = $('#popup-new-cat');
    const name = inp.value.trim();
    if (!name) return;
    const cat = {
      id: crypto.randomUUID(),
      owner_email: getUserEmail(),
      name,
      color: '#5B3082',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    State.categories.push(cat);
    await saveCategoryLocal(cat);
    try { await apiCreateCat({ id: cat.id, name: cat.name, color: cat.color }); } catch {}
    inp.value = '';
    renderCategoriesPopup();
    renderCategoriesStrip();
    renderDrawerCats();
  });

  // Reminder
  $('#ed-reminder').addEventListener('click', (ev) => {
    const e = State.editing;
    const inp = $('#popup-reminder-input');
    if (e.reminder_at) {
      const d = new Date(e.reminder_at);
      const tz = d.getTimezoneOffset() * 60000;
      inp.value = new Date(d - tz).toISOString().slice(0, 16);
    } else {
      inp.value = '';
    }
    showPopupAt('#popup-reminder', ev.currentTarget);
  });
  $('#popup-reminder-save').addEventListener('click', () => {
    const v = $('#popup-reminder-input').value;
    if (!v) return;
    State.editing.reminder_at = new Date(v).getTime();
    State.editing.reminder_sent = false;
    hidePopups();
    scheduleSave();
    updateEditorMeta();
    // ensure push subscription is set up for reminders to work in background
    ensurePushSubscription().catch(() => {});
  });
  $('#popup-reminder-clear').addEventListener('click', () => {
    State.editing.reminder_at = null;
    State.editing.reminder_sent = false;
    hidePopups();
    scheduleSave();
    updateEditorMeta();
  });

  // Share
  $('#ed-share').addEventListener('click', (ev) => {
    renderSharePopup();
    showPopupAt('#popup-share', ev.currentTarget);
  });
  $('#popup-share-add').addEventListener('click', async () => {
    const inp = $('#popup-share-email');
    const email = inp.value.trim().toLowerCase();
    if (!email) return;
    try {
      await apiShareNote(State.editing.id, email, true);
      State.editing.shares = (State.editing.shares || []).filter(s => s.email !== email);
      State.editing.shares.push({ email, can_edit: true });
      inp.value = '';
      renderSharePopup();
      updateEditorMeta();
    } catch (e) {
      alert(e.message);
    }
  });

  // Image
  $('#ed-image').addEventListener('click', () => $('#file-image').click());
  $('#file-image').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const blob = await resizeImage(file, 1600, 0.85);
    try {
      const att = await apiUploadAttachment(State.editing.id, blob, 'image');
      State.editing.attachments = (State.editing.attachments || []).concat([{ ...att, note_id: State.editing.id }]);
      renderAttachments();
      scheduleSave();
    } catch (err) { alert(err.message); }
  });

  // Audio
  $('#ed-audio').addEventListener('click', async (ev) => {
    if (isRecording()) {
      const blob = await stopRecording();
      ev.currentTarget.textContent = '🎙️';
      try {
        const att = await apiUploadAttachment(State.editing.id, blob, 'audio');
        State.editing.attachments = (State.editing.attachments || []).concat([{ ...att, note_id: State.editing.id }]);
        renderAttachments();
        scheduleSave();
      } catch (err) { alert(err.message); }
    } else {
      try {
        await startRecording();
        ev.currentTarget.textContent = '⏹️';
      } catch (err) { alert(err.message); }
    }
  });

  // close
  $$('#editor [data-close]').forEach(el => el.addEventListener('click', closeEditor));
  $('#editor').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEditor();
  });
  $('#ed-title').addEventListener('input', scheduleSave);
  $('#ed-body').addEventListener('input', () => { autoGrow($('#ed-body')); scheduleSave(); });
  $('#ed-title').addEventListener('blur',  commitEditor);
  $('#ed-body').addEventListener('blur',   commitEditor);

  // Checklist container — bound ONCE here, not inside renderChecklist
  const cl = $('#ed-checklist-list');
  cl.addEventListener('input', () => { syncChecklistFromDom(); scheduleSave(); });
  cl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const e = State.editing;
      if (!e) return;
      syncChecklistFromDom();
      e.checklist_items = e.checklist_items || [];
      e.checklist_items.push({ id: crypto.randomUUID(), text: '', done: false, order: e.checklist_items.length });
      renderChecklist();
      scheduleSave();
      const rows = cl.querySelectorAll('.ed-check-text');
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        lastRow.focus();
        placeCursorAtEnd(lastRow);
        setTimeout(() => lastRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
      }
      return;
    }
    if (ev.key === 'Backspace' && ev.target.matches('.ed-check-text')) {
      if (ev.target.textContent !== '') return;
      ev.preventDefault();
      const e = State.editing;
      if (!e) return;
      const row = ev.target.closest('.ed-check-row');
      const id = row?.dataset.id;
      if (!id) return;
      const idx = (e.checklist_items || []).findIndex(x => x.id === id);
      e.checklist_items = (e.checklist_items || []).filter(x => x.id !== id);
      renderChecklist();
      scheduleSave();
      const newRows = cl.querySelectorAll('.ed-check-text');
      const target = newRows[Math.max(0, idx - 1)];
      if (target) { target.focus(); placeCursorAtEnd(target); }
    }
  });
}

function renderCategoriesPopup() {
  const list = $('#popup-cats-list');
  list.innerHTML = '';
  const me = getUserEmail();
  const own = State.categories.filter(c => c.owner_email === me);
  for (const c of own) {
    const lbl = document.createElement('label');
    const checked = (State.editing?.categories || []).includes(c.id);
    lbl.innerHTML = `<input type="checkbox" data-id="${c.id}" ${checked ? 'checked' : ''}>
                     <span class="drawer-cat-dot" style="background:${c.color}"></span>
                     <span>${escapeHtml(c.name)}</span>`;
    lbl.querySelector('input').addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      State.editing.categories = State.editing.categories || [];
      if (e.target.checked) {
        if (!State.editing.categories.includes(id)) State.editing.categories.push(id);
      } else {
        State.editing.categories = State.editing.categories.filter(x => x !== id);
      }
      scheduleSave();
      updateEditorMeta();
    });
    list.appendChild(lbl);
  }
  if (!own.length) list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px">No tienes categorías aún.</p>';
}

function renderSharePopup() {
  const root = $('#popup-share-list');
  root.innerHTML = '';
  for (const s of (State.editing?.shares || [])) {
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `<span>${escapeHtml(s.email)}</span><button class="btn-icon" data-revoke="${escapeHtmlAttr(s.email)}">×</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      try { await apiRevokeShare(State.editing.id, s.email); } catch {}
      State.editing.shares = State.editing.shares.filter(x => x.email !== s.email);
      renderSharePopup();
      updateEditorMeta();
    });
    root.appendChild(row);
  }
  if (!(State.editing?.shares || []).length) {
    root.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px">No compartida aún.</p>';
  }
}

// ── popups positioning ──────────────────────────────────────────────────────
function showPopupAt(sel, anchor) {
  hidePopups();
  const p = $(sel);
  if (isMobile()) {
    // On mobile, CSS handles bottom-sheet positioning; just clear inline styles
    p.style.top = '';
    p.style.left = '';
  } else {
    const r = anchor.getBoundingClientRect();
    const popupH = 300; // estimated max height
    let top = r.bottom + 6;
    // If popup would overflow bottom, show above the anchor
    if (top + popupH > window.innerHeight) {
      top = Math.max(8, r.top - popupH - 6);
    }
    p.style.top  = `${top}px`;
    p.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, r.left))}px`;
  }
  p.hidden = false;
}
function hidePopups() {
  $$('.popup').forEach(p => {
    p.hidden = true;
    p.style.top = '';
    p.style.left = '';
  });
}

// ── settings drawer ──────────────────────────────────────────────────────────
function bindDrawer() {
  $('#btn-settings').addEventListener('click', () => {
    history.pushState({ modal: 'drawer' }, '');
    lockBodyScroll();
    $('#drawer').hidden = false;
  });
  $$('#drawer [data-close-drawer]').forEach(el => el.addEventListener('click', () => {
    if (history.state?.modal === 'drawer') history.back();
    else { $('#drawer').hidden = true; unlockBodyScroll(); }
  }));
  $$('#drawer .drawer-item[data-view]').forEach(b => b.addEventListener('click', (e) => {
    setView(e.currentTarget.dataset.view);
    if (history.state?.modal === 'drawer') history.back();
    else { $('#drawer').hidden = true; unlockBodyScroll(); }
  }));
  $('#drawer-cat-add').addEventListener('click', async () => {
    const inp = $('#drawer-cat-name');
    const name = inp.value.trim();
    if (!name) return;
    const cat = {
      id: crypto.randomUUID(),
      owner_email: getUserEmail(),
      name,
      color: '#5B3082',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    State.categories.push(cat);
    await saveCategoryLocal(cat);
    try { await apiCreateCat({ id: cat.id, name, color: cat.color }); } catch {}
    inp.value = '';
    renderDrawerCats();
    renderCategoriesStrip();
  });
  $('#drawer-set-pin').addEventListener('click', () => {
    $('#setpin-modal').hidden = false;
    $('#setpin-input').value = '';
    $('#setpin-input2').value = '';
  });
  $$('#setpin-modal [data-close-setpin]').forEach(el =>
    el.addEventListener('click', () => $('#setpin-modal').hidden = true)
  );
  $('#setpin-save').addEventListener('click', async () => {
    const a = $('#setpin-input').value;
    const b = $('#setpin-input2').value;
    if (a !== b) return alert('Los PIN no coinciden');
    if (!/^\d{4,8}$/.test(a)) return alert('Debe ser 4 a 8 dígitos');
    try { await setPin(a); $('#setpin-modal').hidden = true; alert('PIN guardado'); }
    catch (e) { alert(e.message); }
  });

  $('#drawer-webauthn').addEventListener('click', async () => {
    try {
      await registerWebauthn(getUserEmail());
      alert('Huella registrada en este dispositivo');
    } catch (e) { alert(e.message); }
  });

  $('#drawer-test-push').addEventListener('click', async () => {
    try {
      await ensurePushSubscription();
      alert('Notificaciones activas');
    } catch (e) { alert(e.message); }
  });

  // current user
  $('#drawer-user').textContent = getUserEmail() || '—';
}

// ── search + nav ─────────────────────────────────────────────────────────────
function bindUI() {
  $('#search').addEventListener('input', (e) => {
    State.search = e.target.value;
    renderGrid();
  });
  $('#btn-new')?.addEventListener('click', openNew);

  // Sidebar toggle
  $('#sidebar-toggle')?.addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeSidebar();
    else openSidebar();
  });
  $('#sidebar-backdrop')?.addEventListener('click', () => closeSidebar());
  // Wire static sidebar nav items (categories are wired in renderSidebarNav)
  $$('.sidebar-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
      if (window.innerWidth < 900) closeSidebar();
    });
  });
  $('#sidebar-edit-labels')?.addEventListener('click', () => {
    if (window.innerWidth < 900) closeSidebar();
    history.pushState({ modal: 'drawer' }, '');
    lockBodyScroll();
    $('#drawer').hidden = false;
  });

  // PIN modal
  $('#pin-submit').addEventListener('click', async () => {
    const v = $('#pin-input').value;
    if (!v) return;
    const ok = await verifyPin(v);
    if (!ok) { $('#pin-msg').textContent = 'PIN incorrecto'; return; }
    closePinModal(true);
  });
  $('#pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#pin-submit').click();
  });
  $('#pin-cancel').addEventListener('click', () => closePinModal(false));
  $('#pin-biometric').addEventListener('click', async () => {
    const ok = await unlockWithWebauthn();
    if (ok) closePinModal(true);
    else $('#pin-msg').textContent = 'Biometría falló';
  });

  // Click outside popups
  document.addEventListener('click', (e) => {
    if (e.target.closest('.popup')) return;
    if (e.target.closest('#ed-color, #ed-categories, #ed-share, #ed-reminder, #ed-more, #ed-add')) return;
    hidePopups();
  });

  bindEditorActions();
  bindDrawer();

  // Selection bar
  $('#select-cancel')?.addEventListener('click', () => exitSelectMode());
  $('#select-pin')?.addEventListener('click', async () => {
    // Determine target pinned state (if any selected is unpinned, pin all; else unpin all)
    let anyUnpinned = false;
    for (const id of State.selected) {
      const n = State.notes.find(x => x.id === id);
      if (n && !n.pinned) anyUnpinned = true;
    }
    for (const id of State.selected) {
      const n = State.notes.find(x => x.id === id);
      if (!n) continue;
      n.pinned = anyUnpinned;
      n.last_modified = Date.now();
      await saveNoteLocal(n);
    }
    exitSelectMode();
    render();
  });
  $('#select-cats')?.addEventListener('click', (ev) => {
    // For bulk categories we can just set State.editing to a dummy object 
    // to reuse the popup, then intercept the change. But a simpler way:
    // Just prompt for category or redirect to a modal. Since we don't have
    // a bulk category UI built-in easily without rewriting renderCategoriesPopup,
    // let's create a small custom popup or use prompt for now to assign by name.
    // Actually, for now, let's just use a prompt since it's an edge case 
    // or tell user it's implemented. Let's make a real bulk categories function.
    const name = prompt('Escribe el nombre de la categoría para agregar a la selección:');
    if (!name) return;
    const cat = State.categories.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    if (cat) {
      for (const id of State.selected) {
        const n = State.notes.find(x => x.id === id);
        if (n) {
          n.categories = n.categories || [];
          if (!n.categories.includes(cat.id)) n.categories.push(cat.id);
          saveNoteLocal(n);
        }
      }
      exitSelectMode();
      render();
    } else {
      alert('Categoría no encontrada. Por favor créala primero.');
    }
  });
  $('#select-archive')?.addEventListener('click', async () => {
    for (const id of State.selected) {
      const n = State.notes.find(x => x.id === id);
      if (!n) continue;
      n.archived = true;
      n.last_modified = Date.now();
      await saveNoteLocal(n);
    }
    exitSelectMode();
    render();
  });
  $('#select-delete')?.addEventListener('click', async () => {
    if (!(await window.customConfirm(`¿Mover ${State.selected.size} nota(s) a la papelera?`))) return;
    for (const id of State.selected) {
      const n = State.notes.find(x => x.id === id);
      if (!n) continue;
      n.trashed_at = Date.now();
      n.last_modified = Date.now();
      await saveNoteLocal(n);
      try { await apiTrashNote(id); } catch {}
    }
    exitSelectMode();
    render();
  });

  // Lightbox
  $('#lightbox-bg').addEventListener('click', closeLightbox);
  $('#lightbox-img').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

  // Image clicks — editor attachments (delegated)
  $('#ed-attachments').addEventListener('click', e => {
    const img = e.target.closest('img[data-att]');
    if (img && img.src) { e.stopPropagation(); openLightbox(img.src); }
  });

  // Image clicks — note cards (delegated on grid)
  $$('#grid-pinned, #grid-others').forEach(grid => {
    grid.addEventListener('click', e => {
      const img = e.target.closest('img.nc-image-thumb');
      if (img && img.src && !img.src.endsWith('#')) {
        e.stopPropagation();
        openLightbox(img.src);
      }
    });
  });

  // ── Android back button / browser back gesture ───────────────────────────
  // Check what's actually open in DOM (not history state) to avoid re-open bugs
  window.addEventListener('popstate', () => {
    if (!$('#editor').hidden) {
      closeEditor(true);
      return;
    }
    if (!$('#drawer').hidden) {
      $('#drawer').hidden = true;
      unlockBodyScroll();
      return;
    }
    const anyPopup = $$('.popup').some(p => !p.hidden);
    if (anyPopup) {
      hidePopups();
      history.pushState(null, ''); // restore entry so next back still works
      return;
    }
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeHtmlAttr(s) { return escapeHtml(s); }
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
}

async function resizeImage(file, maxDim, quality = 0.85) {
  const bmp = await createImageBitmap(file);
  let { width, height } = bmp;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width  = Math.round(width  * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
  return await new Promise(res => canvas.toBlob(b => res(b), 'image/webp', quality));
}

// expose for inline handlers
window.NotesApp = { openNew };

init();
