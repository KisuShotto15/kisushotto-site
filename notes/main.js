// notes/main.js — init, render, view state, event handlers.

import * as idb from './idb.js';
import {
  cfg,
  apiGetMe, apiCreateCat, apiUpdateCat, apiDeleteCat,
  apiShareNote, apiRevokeShare,
  apiUploadAttachment, apiDeleteAttachment, apiAttachmentBlobUrl,
  apiTrashNote, apiRestoreNote, apiPurgeNote,
  apiRegWebauthn,
  apiListPasskeys, apiRenamePasskey, apiDeletePasskey,
  getUserEmail,
} from './api.js';
import { pull, flushQueue, saveNoteLocal, saveCategoryLocal, onConnectionChange, isPushing } from './sync.js';
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
  editorOriginRect: null, // DOMRect of the card that opened the editor (for FLIP close animation)
  attachUrls: {},       // attId -> object URL
  pinPending: null,     // resolver fn while PIN modal open
  selected: new Set(),  // selected note IDs for multi-select
  selectMode: false,
};

let saveTimer = null;

// ── Editor undo/redo ──────────────────────────────────────────────────────────
const EditorHistory = {
  past: [],
  future: [],
  _timer: null,
  _typing: false,
  _sessionStart: null,  // snapshot taken BEFORE the current typing session began

  _capture() {
    if (!State.editing) return null;
    syncChecklistFromDom();
    const e = State.editing;
    return {
      title: $('#ed-title')?.value ?? e.title ?? '',
      body:  $('#ed-body')?.value  ?? htmlToText(e.body || ''),
      type:  e.type,
      checklist_items: JSON.parse(JSON.stringify(e.checklist_items || [])),
      color:        e.color,
      pinned:       e.pinned,
      archived:     e.archived,
      locked:       e.locked,
      reminder_at:  e.reminder_at,
      reminder_sent:e.reminder_sent,
      categories:   [...(e.categories || [])],
    };
  },

  _push(snap) {
    if (!snap) return;
    const last = this.past[this.past.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
    this.past.push(snap);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  },

  // Call when a text field gains focus — captures the before-state for the next typing session
  mark() {
    if (this._typing) return;
    this._sessionStart = this._capture();
  },

  // Call on each text input event
  schedule() {
    if (!this._typing) {
      // First keystroke of this session: push the before-state captured at focus time
      this._push(this._sessionStart);
      this._typing = true;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._typing = false;
      this._sessionStart = this._capture();  // save state as before for the next session
    }, 1500);
  },

  // Call BEFORE a structural (non-text) change
  flush() {
    clearTimeout(this._timer);
    this._typing = false;
    this._push(this._capture());
  },

  undo() {
    if (!this.past.length || !State.editing) return;
    clearTimeout(this._timer);
    this._typing = false;
    const current = this._capture();
    if (current) this.future.push(current);
    this._apply(this.past.pop());
  },

  redo() {
    if (!this.future.length || !State.editing) return;
    clearTimeout(this._timer);
    this._typing = false;
    const current = this._capture();
    if (current) this.past.push(current);
    this._apply(this.future.pop());
  },

  _apply(snap) {
    if (!snap || !State.editing) return;
    const e = State.editing;
    e.title           = snap.title;
    e.body            = snap.body;
    e.type            = snap.type;
    e.checklist_items = JSON.parse(JSON.stringify(snap.checklist_items));
    e.color           = snap.color;
    e.pinned          = snap.pinned;
    e.archived        = snap.archived;
    e.locked          = snap.locked;
    e.reminder_at     = snap.reminder_at;
    e.reminder_sent   = snap.reminder_sent;
    e.categories      = [...snap.categories];

    $('#ed-title').value = snap.title;
    $('#ed-body').value  = snap.body;
    autoGrow($('#ed-body'));
    const isChecklist = snap.type === 'checklist';
    $('#ed-body').hidden           = isChecklist;
    $('#ed-checklist-list').hidden = !isChecklist;
    const card = $('#editor .editor-card');
    card.style.background = snap.color || '';
    card.classList.toggle('colored', !!snap.color);
    renderChecklist();
    updateEditorMeta();
    scheduleSave();
    // After applying, the current state is the before-state for the next session
    this._sessionStart = this._capture();
  },

  clear() {
    clearTimeout(this._timer);
    this._typing      = false;
    this._sessionStart = null;
    this.past         = [];
    this.future       = [];
  },
};

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!getUserEmail()) {
    $('#loginScreen')?.classList.remove('hidden');
    initLoginScreen();
    return;
  }
  $('#loginScreen')?.classList.add('hidden');

  // SW — register first so update runs even if bindUI() crashes below
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.update();
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    }).catch(() => {});
  }

  // ── BIND UI — wrapped so a crash here doesn't abort the whole init ────
  try {
    bindUI();
  } catch (e) {
    console.error('bindUI failed, waiting for SW reload', e);
    return; // SW activate will client.navigate() to reload with fresh JS
  }

  // Online indicator
  updateNetBanner(navigator.onLine);
  onConnectionChange(updateNetBanner);

  // Network-first with short timeout to avoid showing stale data flash
  const networkPromise = (async () => {
    State.user = await apiGetMe();
    await pull();
  })().catch(e => { console.warn('initial sync failed', e); });

  // Wait up to 600ms for pull; if slower, render local (stale) data while it finishes
  if (navigator.onLine) {
    await Promise.race([networkPromise, new Promise(r => setTimeout(r, 600))]);
  }

  try {
    await loadFromIDB();
    render();
  } catch (e) {
    console.warn('IndexedDB load failed (Brave Shields?)', e);
    render();
  }

  // If network was slow, re-render once it finishes
  networkPromise.then(async () => {
    try { await loadFromIDB(); render(); } catch {}
  });

  // Periodic pull — re-render grid or refresh editor if the open note changed
  setInterval(async () => {
    if (!navigator.onLine) return;
    try {
      const { changed, changedNoteIds } = await pull();
      if (!changed) return;
      const editorOpen = !$('#editor').hidden;
      if (editorOpen && State.editing && changedNoteIds?.has(State.editing.id)) {
        // Only refresh the open note if the user isn't actively typing in it,
        // it has no pending push, and the editor has no uncommitted changes —
        // otherwise we'd clobber the user's unsynced edit.
        const userTyping = document.activeElement && $('#editor').contains(document.activeElement)
          && document.activeElement !== document.body;
        const pendingIds = new Set((await idb.peekQueue()).map(i => i.id));
        const dirty = noteContentHash(State.editing) !== State.editorOpenSnapshot;
        if (!userTyping && !pendingIds.has(State.editing.id) && !dirty) {
          const fresh = await idb.getOne('notes', State.editing.id);
          if (fresh) {
            State.editing = fresh;
            State.editingSnapshotTime = fresh.last_modified || 0;
            State.notes[State.notes.findIndex(n => n.id === fresh.id)] = fresh;
            renderChecklist();
            updateEditorMeta();
            $('#ed-status').textContent = 'Actualizado';
          }
        }
      } else if (!editorOpen) {
        await loadFromIDB(); render();
      }
    } catch {}
  }, 10000);

  // Never strand a debounced save: when the app is hidden or the page is being
  // unloaded, commit the open editor and flush the outbox (best-effort).
  const flushOnHide = () => {
    try { commitEditorIfDirty(); } catch {}
    try { flushQueue(); } catch {}
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnHide();
  });
  window.addEventListener('pagehide', flushOnHide);

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
  // Migrate: assign sort_order from created_at (immutable). Using last_modified
  // would mean a note that lost sort_order during sync round-trip would later
  // get bumped to "now" because the server rewrites last_modified to its clock.
  const needsSave = [];
  State.notes.forEach(n => {
    if (n.sort_order == null) {
      n.sort_order = n.created_at || n.last_modified || 0;
      needsSave.push(n);
    }
  });
  if (needsSave.length) needsSave.forEach(n => idb.put('notes', n).catch(() => {}));
  State.notes.sort((a, b) =>
    (b.sort_order ?? 0) - (a.sort_order ?? 0) ||
    (b.created_at ?? 0) - (a.created_at ?? 0)
  );
}

let _lightboxClosedAt = 0;
function openLightbox(src) {
  if (Date.now() - _lightboxClosedAt < 450) return;
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
  history.pushState({ modal: 'lightbox' }, '');
}
function closeLightbox(fromPopState = false) {
  if ($('#lightbox').hidden) return;
  _lightboxClosedAt = Date.now();
  $('#lightbox').hidden = true;
  if (!fromPopState && history.state?.modal === 'lightbox') history.back();
}

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
  // Compensate for scrollbar disappearing so the grid doesn't shift
  const sb = window.innerWidth - document.documentElement.clientWidth;
  if (sb > 0) document.body.style.paddingRight = sb + 'px';
  document.body.style.setProperty('--scroll-y', `-${scrollY}px`);
  document.body.classList.add('modal-open');
  document.body.dataset.scrollY = scrollY;
}

function unlockBodyScroll() {
  const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('--scroll-y');
  document.body.style.paddingRight = '';
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

function placeCursorAtStart(el) {
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function updateNetBanner(online) {
  const el = $('#net-banner');
  if (!el) return;
  el.hidden = !!online;
}

// ── render ───────────────────────────────────────────────────────────────────

// Map of color names (es/en) to the hex palette in index.html. A name matches
// the note if its color hex is in the bucket.
const COLOR_NAME_MAP = {
  red:      ['#5E2020', '#852D2D'],
  rojo:     ['#5E2020', '#852D2D'],
  brown:    ['#5C3520', '#44301F', '#824D23', '#5C3D2E'],
  marron:   ['#5C3520', '#44301F', '#824D23', '#5C3D2E'],
  marrón:   ['#5C3520', '#44301F', '#824D23', '#5C3D2E'],
  yellow:   ['#4F4118', '#6B591D'],
  amarillo: ['#4F4118', '#6B591D'],
  mustard:  ['#4F4118', '#6B591D'],
  green:    ['#1F4A28', '#226333'],
  verde:    ['#1F4A28', '#226333'],
  teal:     ['#194446', '#1A5E63'],
  blue:     ['#20316E', '#2D4494'],
  azul:     ['#20316E', '#2D4494'],
  slate:    ['#28313F', '#334155'],
  purple:   ['#2A2360', '#3F2260', '#585FAA', '#453995', '#3E3282', '#5B3082'],
  morado:   ['#2A2360', '#3F2260', '#585FAA', '#453995', '#3E3282', '#5B3082'],
  violeta:  ['#2A2360', '#3F2260', '#585FAA', '#453995', '#3E3282', '#5B3082'],
  gray:     ['#2E2E33', '#3F3F46'],
  grey:     ['#2E2E33', '#3F3F46'],
  gris:     ['#2E2E33', '#3F3F46'],
  pink:     ['#5C2049', '#822D61'],
  rosa:     ['#5C2049', '#822D61'],
  magenta:  ['#5C2049', '#822D61'],
};

function parseDateToken(s) {
  const t = String(s || '').toLowerCase().trim();
  const now = Date.now();
  const day = 86400000;
  if (t === 'today')     return now - (now % day);
  if (t === 'yesterday') return now - (now % day) - day;
  if (t === 'week')      return now - 7 * day;
  if (t === 'month')     return now - 30 * day;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d) ? null : d.getTime();
  }
  return null;
}

// Parse a query string into structured filters and remaining free text.
// Unknown operator keys fall back into text so typos don't drop matches.
function parseSearchQuery(q) {
  const filters = [];
  const textParts = [];
  // Tokenize respecting "quoted strings"
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) tokens.push(m[1] != null ? `"${m[1]}"` : m[2]);

  for (const tok of tokens) {
    const quoted = tok.startsWith('"') && tok.endsWith('"');
    if (quoted) { textParts.push(tok.slice(1, -1)); continue; }
    const i = tok.indexOf(':');
    if (i <= 0) { textParts.push(tok); continue; }
    const key = tok.slice(0, i).toLowerCase();
    const val = tok.slice(i + 1).toLowerCase();
    if (!val) { textParts.push(tok); continue; }
    switch (key) {
      case 'color': {
        const hexes = COLOR_NAME_MAP[val] || (val.startsWith('#') ? [val.toUpperCase()] : null);
        if (!hexes) { textParts.push(tok); break; }
        filters.push(n => n.color && hexes.includes(n.color.toUpperCase()));
        break;
      }
      case 'category':
      case 'cat': {
        if (key === 'cat' && val.length > 8) {
          filters.push(n => (n.categories || []).includes(val));
        } else {
          const me = getUserEmail();
          const match = State.categories.find(c => c.owner_email === me && (c.name || '').toLowerCase() === val);
          if (!match) { filters.push(_ => false); break; }
          filters.push(n => (n.categories || []).includes(match.id));
        }
        break;
      }
      case 'has': {
        if (val === 'image' || val === 'audio') {
          filters.push(n => (n.attachments || []).some(a => a.type === val));
        } else if (val === 'attachment' || val === 'attach') {
          filters.push(n => (n.attachments || []).length > 0);
        } else if (val === 'checklist') {
          filters.push(n => n.type === 'checklist');
        } else if (val === 'reminder') {
          filters.push(n => n.reminder_at && n.reminder_at > Date.now());
        } else { textParts.push(tok); }
        break;
      }
      case 'before': {
        const t = parseDateToken(val);
        if (t == null) { textParts.push(tok); break; }
        filters.push(n => (n.created_at || 0) < t);
        break;
      }
      case 'after': {
        const t = parseDateToken(val);
        if (t == null) { textParts.push(tok); break; }
        filters.push(n => (n.created_at || 0) > t);
        break;
      }
      case 'archived': {
        if (val === 'true')       filters.push({ _override: 'includeArchived' });
        else if (val === 'false') filters.push(n => !n.archived);
        else textParts.push(tok);
        break;
      }
      case 'pinned': {
        if (val === 'true')       filters.push(n => !!n.pinned);
        else if (val === 'false') filters.push(n => !n.pinned);
        else textParts.push(tok);
        break;
      }
      case 'is': {
        if (val === 'locked')      filters.push(n => !!n.locked);
        else if (val === 'shared') {
          const me = getUserEmail();
          filters.push(n => n.owner_email !== me || (n.shares?.length > 0));
        } else if (val === 'pinned') filters.push(n => !!n.pinned);
        else textParts.push(tok);
        break;
      }
      default:
        textParts.push(tok);
    }
  }
  return { filters, text: textParts.join(' ').trim().toLowerCase() };
}

function getCurrentNotes() {
  const v = State.view;
  const me = getUserEmail();
  const parsed = parseSearchQuery(State.search || '');
  const includeArchived = parsed.filters.some(f => f && f._override === 'includeArchived');
  const predicates = parsed.filters.filter(f => typeof f === 'function');

  return State.notes.filter(n => {
    if (v === 'trash')   return !!n.trashed_at;
    if (n.trashed_at)    return false;
    if (v === 'archive') return !!n.archived && !n.locked;
    if (v === 'locked')  return !!n.locked;
    if (n.archived && !v.startsWith('cat:') && !includeArchived) return false;
    if (v === 'shared')  return n.owner_email !== me || (n.shares?.length > 0);
    if (v.startsWith('cat:')) {
      const id = v.slice(4);
      return (n.categories || []).includes(id);
    }
    // 'all'
    return true;
  }).filter(n => predicates.every(p => p(n))).filter(n => {
    if (!parsed.text) return true;
    const hay = (
      (n.title || '') + ' ' +
      (n.body || '') + ' ' +
      (n.checklist_items || []).map(c => c.text).join(' ')
    ).toLowerCase();
    return hay.includes(parsed.text);
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
      <span class="sidebar-cat-icon">${c.icon || '🏷️'}</span>
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
  const sidebar = $('#sidebar-nav-wrapper') || $('.sidebar');
  if (sidebar) sidebar.style.transform = '';
  $('#sidebar-backdrop').style.display = 'none';
}

function initSidebarSwipe() {
  const sidebar = $('.sidebar');
  if (!sidebar) return;
  let startX = 0, startY = 0, dragging = false;
  const THRESHOLD = 60;

  sidebar.addEventListener('touchstart', e => {
    if (!document.body.classList.contains('sidebar-open')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = false;
  }, { passive: true });

  sidebar.addEventListener('touchmove', e => {
    if (!document.body.classList.contains('sidebar-open')) return;
    const dx = e.touches[0].clientX - startX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!dragging && dy > 10) return; // vertical scroll, ignore
    if (dx < 0) {
      dragging = true;
      sidebar.style.transition = 'none';
      sidebar.style.transform = `translateX(${dx}px)`;
    }
  }, { passive: true });

  sidebar.addEventListener('touchend', e => {
    if (!dragging) return;
    const dx = e.changedTouches[0].clientX - startX;
    sidebar.style.transition = '';
    if (dx < -THRESHOLD) {
      closeSidebar();
    } else {
      sidebar.style.transform = 'translateX(0)';
    }
    dragging = false;
  }, { passive: true });
}

async function reorderCategoryDrag(srcId, targetId) {
  if (!srcId || !targetId || srcId === targetId) return;
  const me = getUserEmail();
  const cats = State.categories.filter(c => c.owner_email === me)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const srcIdx = cats.findIndex(c => c.id === srcId);
  const tgtIdx = cats.findIndex(c => c.id === targetId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const [moved] = cats.splice(srcIdx, 1);
  cats.splice(tgtIdx, 0, moved);
  const t = Date.now();
  cats.forEach((c, i) => { c.sort_order = i; c.updated_at = t; });
  await Promise.all(cats.map(c => saveCategoryLocal(c)));
  renderCategoriesStrip();
  renderDrawerCats();
}

const TRASH_SVG  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 13a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const PENCIL_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 014 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
const GRIP_SVG  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
const CAT_ICONS = ['🏷️','📁','🏠','💼','📚','🎯','🍽️','💪','💰','🎨','✈️','🎮','🎵','💡','🛒','🌿','🔧','❤️','📝','🏃','🎬','📊','⭐','🔔','🎁','🇯🇵'];

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
    row.dataset.id = c.id;

    const grip = document.createElement('span');
    grip.className = 'drag-handle cat-grip';
    grip.innerHTML = GRIP_SVG;

    const iconBtn = document.createElement('button');
    iconBtn.className = 'cat-icon-btn';
    iconBtn.textContent = c.icon || '🏷️';
    iconBtn.title = 'Cambiar icono';

    const inp = document.createElement('input');
    inp.className = 'drawer-cat-name';
    inp.value = c.name;
    inp.dataset.id = c.id;

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.dataset.del = c.id;
    delBtn.innerHTML = TRASH_SVG;

    inp.addEventListener('change', async () => {
      const cat = State.categories.find(x => x.id === c.id);
      if (!cat) return;
      cat.name = inp.value.trim() || cat.name;
      cat.updated_at = Date.now();
      await saveCategoryLocal(cat);
      try { await apiUpdateCat(c.id, { name: cat.name }); } catch {}
      renderCategoriesStrip();
    });

    iconBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openIconPicker(c.id, iconBtn);
    });

    delBtn.addEventListener('click', async () => {
      if (!(await window.customConfirm('¿Eliminar categoría? Las notas no se borran.'))) return;
      try { await apiDeleteCat(c.id); } catch {}
      State.categories = State.categories.filter(x => x.id !== c.id);
      await idb.del('categories', c.id);
      renderCategoriesStrip();
      renderDrawerCats();
      render();
    });

    row.append(grip, iconBtn, inp, delBtn);
    root.appendChild(row);
  }

  // ── Mouse drag (handle-activated) ───────────────────────────────────────
  let dragSrcId = null;
  root.querySelectorAll('.drawer-cat-row').forEach(row => {
    row.addEventListener('dragstart', ev => {
      if (!row.draggable) { ev.preventDefault(); return; }
      dragSrcId = row.dataset.id;
      ev.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.draggable = false; });
    row.addEventListener('dragover', ev => {
      ev.preventDefault();
      root.querySelectorAll('.drawer-cat-row').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', ev => {
      ev.preventDefault();
      row.classList.remove('drag-over');
      if (dragSrcId && dragSrcId !== row.dataset.id) reorderCategoryDrag(dragSrcId, row.dataset.id);
      dragSrcId = null;
    });
    row.querySelector('.cat-grip')?.addEventListener('mousedown', () => { row.draggable = true; });
  });

  // ── Touch drag ──────────────────────────────────────────────────────────
  root.querySelectorAll('.cat-grip').forEach(handle => {
    let touchSrcId = null;
    handle.addEventListener('touchstart', ev => {
      touchSrcId = handle.closest('.drawer-cat-row')?.dataset.id;
      ev.preventDefault();
    }, { passive: false });
    handle.addEventListener('touchmove', ev => {
      if (!touchSrcId) return;
      ev.preventDefault();
      const touch = ev.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = el?.closest('.drawer-cat-row');
      root.querySelectorAll('.drawer-cat-row').forEach(r => r.classList.remove('drag-over'));
      if (targetRow && targetRow.dataset.id !== touchSrcId) targetRow.classList.add('drag-over');
    }, { passive: false });
    handle.addEventListener('touchend', ev => {
      if (!touchSrcId) return;
      const touch = ev.changedTouches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const targetRow = el?.closest('.drawer-cat-row');
      root.querySelectorAll('.drawer-cat-row').forEach(r => r.classList.remove('drag-over'));
      if (targetRow && targetRow.dataset.id !== touchSrcId) reorderCategoryDrag(touchSrcId, targetRow.dataset.id);
      touchSrcId = null;
    }, { passive: false });
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
    const items = (n.checklist_items || []).slice(0, 24);
    body = `<div class="nc-body">` + items.map((it, idx) =>
      `<div class="nc-checklist-line ${it.done ? 'done' : ''}" data-idx="${idx}"><input type="checkbox" ${it.done ? 'checked' : ''}> ${escapeHtml(it.text || '')}</div>`
    ).join('') + (items.length < (n.checklist_items?.length || 0) ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">+${(n.checklist_items?.length || 0) - items.length} más</div>` : '') + `</div>`;
  } else {
    body = `<div class="nc-body">${escapeHtml(htmlToText(n.body || '')).slice(0, 2000)}</div>`;
  }

  let imgs = '';
  if (n.attachments?.length) {
    const imgAtts = n.attachments.filter(a => a.type === 'image');
    if (imgAtts.length) imgs += `<div class="nc-imgs-row">${imgAtts.map(a => `<img class="nc-image-thumb" data-att="${a.id}" alt="" loading="lazy" draggable="false">`).join('')}</div>`;
    const audios = n.attachments.filter(a => a.type === 'audio');
    for (const a of audios) imgs += `<audio class="nc-audio" controls preload="none" data-att="${a.id}"></audio>`;
  }

  const cats = (n.categories || []).map(cid => State.categories.find(c => c.id === cid)).filter(Boolean);
  const catTags = cats.map(c => `<span class="nc-cat-tag">${c.icon || '🏷️'} ${escapeHtml(c.name)}</span>`).join('');
  const sharedBadge = isShared ? `<span class="nc-shared">📥 Compartida</span>` : '';
  const lockBadge = n.locked ? `<span class="nc-locked" style="display:inline-flex;align-items:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span>` : '';
  const reminderBadge = n.reminder_at ? `<span>⏰ ${fmtDate(n.reminder_at)}</span>` : '';
  const archiveBadge = n.archived ? `<span class="nc-archive-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 011-1h18a1 1 0 011 1v3a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/><path d="M4 8v10a2 2 0 002 2h12a2 2 0 002-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg></span>` : '';

  return `
    <article class="${cls}" ${style} data-id="${n.id}" onclick="">
      <label class="nc-select-wrap"><input type="checkbox" class="nc-select-cb" data-id="${n.id}" ${isSelected ? 'checked' : ''}></label>
      ${n.pinned ? '<span class="nc-pin"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg></span>' : ''}
      ${archiveBadge}
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

// ── Undo toast (archive / delete) ────────────────────────────────────────────
let _undoToast = null, _undoToastTimer = null;
function showUndoToast(message, undoFn, commitFn) {
  if (_undoToastTimer) clearTimeout(_undoToastTimer);
  if (_undoToast) { _undoToast._dismiss('commit'); }

  const backdrop = document.createElement('div');
  backdrop.className = 'swipe-toast-backdrop';
  document.body.appendChild(backdrop);

  const toast = document.createElement('div');
  toast.className = 'swipe-toast';
  toast.innerHTML = `<span>${message}</span><button class="swipe-toast-undo">Deshacer</button>`;
  document.body.appendChild(toast);
  _undoToast = toast;

  const swallowNextClick = () => {
    const blocker = (e) => { e.preventDefault(); e.stopPropagation(); };
    document.addEventListener('click', blocker, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', blocker, true), 500);
  };

  let finished = false;
  const dismiss = (kind) => {
    if (finished) return;
    finished = true;
    clearTimeout(_undoToastTimer);
    backdrop.remove();
    toast.classList.remove('swipe-toast-show');
    setTimeout(() => { if (_undoToast === toast) { toast.remove(); _undoToast = null; } }, 280);
    if (kind === 'undo') undoFn?.();
    else commitFn?.();
  };
  toast._dismiss = dismiss;

  const btn = toast.querySelector('.swipe-toast-undo');
  btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick();
    dismiss('undo');
  });

  backdrop.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  backdrop.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick();
    dismiss('commit');
  });

  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('swipe-toast-show')));
  _undoToastTimer = setTimeout(() => dismiss('commit'), 6000);
}

const ARCHIVE_ICON_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4a1 1 0 011-1h18a1 1 0 011 1v3a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"/><path d="M4 8v10a2 2 0 002 2h12a2 2 0 002-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>`;
const SWIPE_THRESHOLD = 0.38;
const SWIPE_ACTIVE_COLOR = 'rgba(67,160,71,0.92)';

// ── Drag-to-reorder state ────────────────────────────────────────────────────
let _dragState = null; // { noteId, ghost, card, offsetX, offsetY, container }
let _dragHappened = false;
let _dragScrollBlock = null;

function startDrag(card, x, y) {
  if (_dragState) return;
  const container = card.closest('#grid-pinned, #grid-others');
  if (!container) return;
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.removeAttribute('data-id');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    pointerEvents: 'none',
    zIndex: '500',
    opacity: '0.95',
    boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
    transform: 'scale(1.04)',
    transition: 'box-shadow 0.15s, transform 0.15s',
    borderRadius: getComputedStyle(card).borderRadius,
    margin: '0',
  });
  document.body.appendChild(ghost);
  document.body.classList.add('dragging-note');
  navigator.vibrate?.(18);
  // Prevent iOS from taking over scroll during drag
  _dragScrollBlock = (e) => e.preventDefault();
  document.addEventListener('touchmove', _dragScrollBlock, { passive: false });

  // Freeze the layout: snapshot every card's home slot. We never touch the DOM
  // during the drag — only transform other cards to open a gap. This avoids the
  // masonry column re-pack feedback loop that caused oscillation.
  const order = [...container.querySelectorAll('.note-card')];
  const slotRect = order.map(c => c.getBoundingClientRect());
  const cols = [...new Set(slotRect.map(r => Math.round(r.left)))].sort((a, b) => a - b);
  const fromIndex = order.indexOf(card);

  // Hide the original but keep it in flow so the snapshot stays valid.
  card.style.visibility = 'hidden';
  order.forEach(c => { if (c !== card) c.style.willChange = 'transform'; });

  _dragState = {
    noteId: card.dataset.id,
    ghost, card, container,
    offsetX: x - rect.left,
    offsetY: y - rect.top,
    w: rect.width, h: rect.height,
    order, slotRect, cols, fromIndex,
    lastIns: fromIndex,
  };
}

// Column index of an x-coordinate within the frozen layout.
function dragColOf(cols, x) {
  let idx = 0;
  for (let k = 0; k < cols.length; k++) if (x >= cols[k] - 1) idx = k;
  return idx;
}

function updateDrag(x, y) {
  if (!_dragState) return;
  const s = _dragState;
  const { ghost, card, offsetX, offsetY, w, h, order, slotRect, cols, fromIndex } = s;

  // Ghost follows the cursor every frame.
  ghost.style.left = (x - offsetX) + 'px';
  ghost.style.top  = (y - offsetY) + 'px';

  // Where the ghost's center sits (not the raw cursor).
  const gx = x - offsetX + w / 2;
  const gy = y - offsetY + h / 2;
  const gCol = dragColOf(cols, gx);
  const nOthers = order.length - 1;

  // Walk the gap toward the ghost using the DISPLACED (visual) positions of the
  // neighbouring cards, with a dead band. The gap itself sits at slotRect[ins];
  // moving the cursor anywhere inside it never crosses a neighbour threshold, so
  // the displaced card no longer snaps back when the cursor enters the gap.
  let ins = s.lastIns;
  // Move the gap DOWN as soon as the ghost enters the card below it. The dead
  // band that prevents snap-back is the full slot between neighbours (advance
  // tests slotRect[ins+1], retreat tests slotRect[ins-1]), so a small 0.2
  // margin keeps the gap tracking the cursor closely without flicker.
  while (ins < nOthers) {
    const r = slotRect[ins + 1];                 // displaced rect of card below gap
    const cCol = dragColOf(cols, r.left + r.width / 2);
    if (gCol > cCol || (gCol === cCol && gy > r.top + 0.2 * r.height)) ins++;
    else break;
  }
  // Move the gap UP as soon as the ghost enters the card above it.
  while (ins > 0) {
    const r = slotRect[ins - 1];                 // displaced rect of card above gap
    const cCol = dragColOf(cols, r.left + r.width / 2);
    if (gCol < cCol || (gCol === cCol && gy < r.top + 0.8 * r.height)) ins--;
    else break;
  }
  if (ins === s.lastIns) return; // no change → leave transforms as they are
  s.lastIns = ins;

  // Shift each non-dragged card from its home slot to the slot it occupies once
  // the dragged card is inserted at `ins`. Reference positions are frozen, so
  // there is no feedback loop and no oscillation.
  let j = 0;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    if (c === card) continue;
    const targetSlot = (j < ins) ? j : j + 1; // gap reserved at slot `ins`
    const dx = slotRect[targetSlot].left - slotRect[i].left;
    const dy = slotRect[targetSlot].top  - slotRect[i].top;
    c.style.transition = 'transform 0.18s cubic-bezier(0.2,0,0,1)';
    c.style.transform = (dx || dy) ? `translate(${dx}px,${dy}px)` : '';
    j++;
  }
}

function endDrag() {
  if (!_dragState) return;
  const { ghost, card, noteId, container, order, slotRect, lastIns } = _dragState;
  _dragState = null;
  _dragHappened = true;

  // Deselect the dragged card; exit select mode if nothing else remains.
  if (State.selectMode && State.selected.has(noteId)) {
    toggleSelect(noteId);
    if (State.selected.size === 0) exitSelectMode();
  }

  // Commit the new DOM order within this container.
  const others = order.filter(c => c !== card);
  const finalOrder = [...others.slice(0, lastIns), card, ...others.slice(lastIns)];
  finalOrder.forEach(c => container.appendChild(c));

  // Clear frozen-drag styling now that the DOM reflects the final order.
  order.forEach(c => { c.style.transition = ''; c.style.transform = ''; c.style.willChange = ''; });
  card.style.visibility = '';

  // Land the ghost on the dragged card's final slot, then remove it.
  const landRect = slotRect[Math.min(lastIns, slotRect.length - 1)] || slotRect[0];
  ghost.style.transition = 'left 0.16s ease, top 0.16s ease, transform 0.16s ease, opacity 0.16s ease';
  if (landRect) { ghost.style.left = landRect.left + 'px'; ghost.style.top = landRect.top + 'px'; }
  ghost.style.transform = 'scale(1)';
  ghost.style.opacity = '0';
  setTimeout(() => ghost.remove(), 180);

  document.body.classList.remove('dragging-note');
  if (_dragScrollBlock) {
    document.removeEventListener('touchmove', _dragScrollBlock);
    _dragScrollBlock = null;
  }

  // Save sort_order based on the new combined DOM positions.
  const gridPinned = $('#grid-pinned');
  const gridOthers = $('#grid-others');
  const allCards = [
    ...(gridPinned ? gridPinned.querySelectorAll('.note-card') : []),
    ...(gridOthers ? gridOthers.querySelectorAll('.note-card') : []),
  ];
  const total = allCards.length;
  const now = Date.now();
  allCards.forEach((c, i) => {
    const note = State.notes.find(n => n.id === c.dataset.id);
    if (!note) return;
    const newOrder = (total - i) * 1000 + now;
    if (note.sort_order !== newOrder) {
      note.sort_order = newOrder;
      saveNoteLocal(note);
    }
  });
  State.notes.sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));
  renderGrid();
}

function wireCard(card) {
  let _sx = 0, _sy = 0, _dir = null, _active = false, _overlay = null;
  let _dragMode = false;
  let _dragArmed = false; // set when select fires from hold; next move starts drag

  function removeOverlay() {
    if (_overlay) { _overlay.remove(); _overlay = null; }
  }

  function resetCard() {
    card.style.transition = 'transform 0.2s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.2s';
    card.style.transform = '';
    card.style.opacity = '';
    card.style.zIndex = '';
    card.style.willChange = '';
    removeOverlay();
    _active = false; _dir = null; _dragMode = false;
  }

  // ── Touch ────────────────────────────────────────────────────────────────

  card.addEventListener('touchstart', (ev) => {
    _sx = ev.touches[0].clientX;
    _sy = ev.touches[0].clientY;
    _dir = null; _active = false; _dragMode = false; _dragArmed = false;
    removeOverlay();
    card.style.transition = 'none';

    // 150ms hold → silently arm drag (no select mode yet)
    card._dragArmTimer = setTimeout(() => {
      if (!_active) _dragArmed = true;
    }, 150);

    // 280ms hold → enter select mode + select this card
    card._selectTimer = setTimeout(() => {
      if (!_active) {
        enterSelectMode();
        toggleSelect(card.dataset.id);
        navigator.vibrate?.(10);
      }
    }, 280);
  }, { passive: true });

  card.addEventListener('touchmove', (ev) => {
    const dx = ev.touches[0].clientX - _sx;
    const dy = ev.touches[0].clientY - _sy;
    const dist = Math.hypot(dx, dy);

    // Only cancel hold timers when the finger moves meaningfully (not jitter)
    if (dist > 10 && !_dragArmed) {
      clearTimeout(card._dragArmTimer);
      clearTimeout(card._selectTimer);
    }

    if (_dragMode) {
      ev.preventDefault();
      updateDrag(ev.touches[0].clientX, ev.touches[0].clientY);
      return;
    }

    // Hold already triggered select on this touch — any movement starts drag
    if (_dragArmed && dist > 6) {
      _dragArmed = false;
      _dragMode = true;
      ev.preventDefault();
      startDrag(card, ev.touches[0].clientX, ev.touches[0].clientY);
      return;
    }

    if (State.selectMode) return;

    if (!_dir && dist > 6) {
      _dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (_dir !== 'h') return;

    const canArchive = State.view !== 'archive' && State.view !== 'trash';
    if (!canArchive) return;

    ev.preventDefault();
    card.style.willChange = 'transform, opacity';
    _active = true;

    const pct = Math.min(Math.abs(dx) / card.offsetWidth, 1);
    card.style.transform = `translateX(${dx}px)`;
    card.style.opacity = String(1 - pct * 0.6);
  }, { passive: false });

  card.addEventListener('touchend', (ev) => {
    clearTimeout(card._dragArmTimer);
    clearTimeout(card._selectTimer);

    if (_dragMode) {
      _dragMode = false;
      endDrag();
      return;
    }

    card.style.willChange = '';

    if (!_active) { removeOverlay(); _dir = null; return; }
    const dx = ev.changedTouches[0].clientX - _sx;
    const canArchive = State.view !== 'archive' && State.view !== 'trash';

    if (Math.abs(dx) > card.offsetWidth * SWIPE_THRESHOLD && canArchive) {
      const sign = dx > 0 ? 1 : -1;
      const n = State.notes.find(x => x.id === card.dataset.id);
      if (!n) { resetCard(); return; }

      const h = card.offsetHeight;
      const mb = parseFloat(getComputedStyle(card).marginBottom) || 0;

      card.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
      card.style.transform = `translateX(${sign * (card.offsetWidth + 80)}px)`;
      card.style.opacity = '0';
      card.style.pointerEvents = 'none';

      // After horizontal slide, collapse height so the grid reflows.
      setTimeout(() => {
        card.style.transition = 'max-height 0.18s ease, margin-bottom 0.18s ease';
        card.style.overflow = 'hidden';
        card.style.maxHeight = h + 'px';
        card.style.marginBottom = mb + 'px';
        requestAnimationFrame(() => {
          card.style.maxHeight = '0';
          card.style.marginBottom = '0';
        });
      }, 180);

      showUndoToast('Nota archivada',
        () => {
          card.style.transition = 'max-height 0.18s ease, margin-bottom 0.18s ease, transform 0.2s ease-out, opacity 0.2s ease-out';
          card.style.maxHeight = '';
          card.style.marginBottom = '';
          card.style.transform = '';
          card.style.opacity = '';
          card.style.pointerEvents = '';
          card.style.overflow = '';
          setTimeout(() => {
            card.style.transition = '';
            card.style.willChange = '';
          }, 220);
        },
        () => {
          n.archived = true;
          n.last_modified = Date.now();
          saveNoteLocal(n);
        }
      );
    } else {
      resetCard();
    }
    _active = false; _dir = null;
  }, { passive: true });

  card.addEventListener('touchcancel', () => {
    clearTimeout(card._dragArmTimer);
    clearTimeout(card._selectTimer);
    if (_dragMode) { _dragMode = false; endDrag(); return; }
    resetCard();
  }, { passive: true });

  // ── Mouse (desktop hold+drag) ─────────────────────────────────────────────

  card.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || State.selectMode) return;
    const startX = ev.clientX, startY = ev.clientY;
    let dragStarted = false;

    const onMove = (e) => {
      if (dragStarted) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= 4) return;
      // Any movement while holding starts the drag immediately — no delay.
      dragStarted = true;
      document.removeEventListener('mousemove', onMove);
      startDrag(card, startX, startY);
      const onDragMove = (e2) => updateDrag(e2.clientX, e2.clientY);
      const onDragUp = () => { document.removeEventListener('mousemove', onDragMove); endDrag(); };
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragUp, { once: true });
      updateDrag(e.clientX, e.clientY);
    };
    const onUp = () => document.removeEventListener('mousemove', onMove);

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  });

  // ── Click ────────────────────────────────────────────────────────────────

  card.addEventListener('click', (ev) => {
    if (_dragHappened) { _dragHappened = false; return; }
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
        newEl.style.animation = 'none'; // no re-animate replaced cards
        el.replaceWith(newEl);
        wireCard(newEl);
        existing.set(n.id, newEl);
        el = newEl;
      } else {
        el.style.animation = 'none'; // already in DOM, no re-animate on reorder
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
  const archBtn = $('#select-archive');
  if (archBtn) archBtn.title = State.view === 'archive' ? 'Desarchivar' : 'Archivar';
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

// ── visual-viewport keyboard fix ─────────────────────────────────────────────
// When the software keyboard opens in overlay mode (Android Chrome, iOS Safari),
// window.innerHeight stays the same but visualViewport.height shrinks.
// We explicitly set the editor modal's height/top to match the visual viewport
// so the flex layout keeps the bottom bar above the keyboard at all times.
let _vvCleanup = null;
function _updateEditorViewport() {
  const modal = document.getElementById('editor');
  if (!modal || modal.hidden) return;
  const vp = window.visualViewport;
  const h  = vp ? vp.height    : window.innerHeight;
  const t  = vp ? vp.offsetTop : 0;
  modal.style.top    = t + 'px';
  modal.style.height = h + 'px';
}
function attachKeyboardListener() {
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', _updateEditorViewport);
  window.visualViewport.addEventListener('scroll', _updateEditorViewport);
  window.addEventListener('resize', _updateEditorViewport);
  _vvCleanup = () => {
    window.visualViewport.removeEventListener('resize', _updateEditorViewport);
    window.visualViewport.removeEventListener('scroll', _updateEditorViewport);
    window.removeEventListener('resize', _updateEditorViewport);
    const modal = document.getElementById('editor');
    if (modal) { modal.style.top = ''; modal.style.height = ''; }
  };
}
function detachKeyboardListener() {
  if (_vvCleanup) { _vvCleanup(); _vvCleanup = null; }
}

// Stable hash of the editable content of a note — used to detect whether
// the user actually changed anything in the editor before deciding to push.
function noteContentHash(n) {
  if (!n) return '';
  return JSON.stringify({
    title: n.title || '',
    body: n.body || '',
    type: n.type || 'text',
    checklist_items: (n.checklist_items || []).map(it => ({
      id: it.id, text: it.text || '', done: !!it.done, order: it.order,
    })),
    color: n.color || null,
    pinned: !!n.pinned,
    archived: !!n.archived,
    trashed_at: n.trashed_at || null,
    locked: !!n.locked,
    reminder_at: n.reminder_at || null,
    attachments: (n.attachments || []).map(a => a.id),
    categories: [...(n.categories || [])].sort(),
  });
}

// ── editor ───────────────────────────────────────────────────────────────────

// Origin rect for the open/close minimize animation: the note's grid card if it
// exists, otherwise the + FAB (new notes).
function editorAnchorRect(noteId) {
  const card = noteId && document.querySelector(`.note-card[data-id="${noteId}"]`);
  if (card) { const r = card.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return r; }
  const fab = document.getElementById('fab-new');
  if (fab) { const r = fab.getBoundingClientRect(); if (r.width > 0) return r; }
  return null;
}

// Google Keep-style open: the card expands from `fromRect` to the modal size.
function animateEditorOpen(fromRect) {
  const modal = $('#editor');
  const modalCard = modal.querySelector('.modal-card');
  const modalBg   = modal.querySelector('.modal-bg');
  if (!modalCard) return;
  modalCard.style.animation = 'none'; // we drive this via JS, not the CSS keyframe
  if (!fromRect) return;
  const to = modalCard.getBoundingClientRect();
  if (!to.width || !to.height) return;
  const scaleX = Math.max(fromRect.width  / to.width,  0.01);
  const scaleY = Math.max(fromRect.height / to.height, 0.01);
  const tx = fromRect.left + fromRect.width  / 2 - (to.left + to.width  / 2);
  const ty = fromRect.top  + fromRect.height / 2 - (to.top  + to.height / 2);
  modalCard.style.transformOrigin = 'center center';
  modalCard.style.transform = `translate(${tx}px, ${ty}px) scale(${scaleX}, ${scaleY})`;
  modalCard.style.willChange = 'transform';
  if (modalBg) { modalBg.style.animation = 'none'; modalBg.style.opacity = '0'; modalBg.style.transition = 'opacity 0.2s ease'; }
  modalCard.getBoundingClientRect(); // force reflow so the transition runs from here
  requestAnimationFrame(() => {
    modalCard.style.transition = 'transform 0.24s cubic-bezier(0.2,0,0,1)';
    modalCard.style.transform = 'translate(0px, 0px) scale(1, 1)';
    if (modalBg) modalBg.style.opacity = '1';
    const clear = () => {
      modalCard.style.transition = ''; modalCard.style.transform = '';
      modalCard.style.transformOrigin = ''; modalCard.style.willChange = '';
      // Keep animation disabled: resetting to '' re-applies the CSS `editorIn`
      // keyframe (the element still matches .modal:not([hidden]) .modal-card),
      // which replays the open animation — the "weird refresh". onCloseEnd's
      // cssText reset clears this once the modal is hidden.
      modalCard.style.animation = 'none';
      if (modalBg) { modalBg.style.transition = ''; modalBg.style.opacity = ''; modalBg.style.animation = 'none'; }
    };
    modalCard.addEventListener('transitionend', clear, { once: true });
    setTimeout(clear, 320);
  });
}

function openEditor(n) {
  State.editing = JSON.parse(JSON.stringify(n));
  State.editingSnapshotTime = n.last_modified || 0;
  State.editorOpenSnapshot = noteContentHash(State.editing);
  EditorHistory.clear();
  const e = State.editing;

  // Capture card position for FLIP close animation
  const originCard = document.querySelector(`.note-card[data-id="${n.id}"]`);
  State.editorOriginRect = originCard ? originCard.getBoundingClientRect() : null;
  // Leave an empty gap where the note was, so it looks lifted out (Keep-style).
  // visibility:hidden keeps the card's layout box, so the grid doesn't reflow.
  if (originCard) originCard.style.visibility = 'hidden';

  // Push history entry so Android back button closes editor instead of exiting
  history.pushState({ modal: 'editor' }, '');

  lockBodyScroll();
  $('#editor').hidden = false;
  attachKeyboardListener();
  _updateEditorViewport();
  const card = $('#editor .editor-card');
  card.style.background = e.color || '';
  card.classList.toggle('colored', !!e.color);
  $('#ed-title').value = e.title || '';
  const isChecklist = e.type === 'checklist';
  // Unhide the textarea BEFORE measuring — autoGrow reads scrollHeight, which is
  // 0 while the element is display:none (e.g. coming from a checklist note),
  // which would collapse a long note until reopened.
  $('#ed-body').hidden = isChecklist;
  $('#ed-checklist-list').hidden = !isChecklist;
  $('#ed-body').value  = htmlToText(e.body || '');
  if (!isChecklist) {
    autoGrow($('#ed-body'));
    // Re-measure once layout settles and once webfonts load (metrics change).
    requestAnimationFrame(() => {
      if (State.editing === e && !$('#ed-body').hidden) autoGrow($('#ed-body'));
    });
    document.fonts?.ready.then(() => {
      if (State.editing === e && !$('#ed-body').hidden) autoGrow($('#ed-body'));
    });
  }

  renderChecklist();
  renderAttachments();
  updateEditorMeta();
  $('#ed-status').textContent = '';

  // Expand from the note's card (or the + FAB for new notes).
  animateEditorOpen(State.editorOriginRect || editorAnchorRect(n.id));

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
  EditorHistory.flush();
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
    handle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

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

    chk.addEventListener('change', () => { EditorHistory.flush(); it.done = chk.checked; row.classList.toggle('done', chk.checked); scheduleSave(); });
    txt.addEventListener('focus', () => {
      root.querySelectorAll('.ed-check-row').forEach(r => r.classList.remove('row-selected'));
      row.classList.add('row-selected');
    });
    del.addEventListener('click', () => {
      EditorHistory.flush();
      const idx = e.checklist_items.findIndex(x => x.id === it.id);
      e.checklist_items = e.checklist_items.filter(x => x.id !== it.id);
      renderChecklist();
      scheduleSave();
      const rows = root.querySelectorAll('.ed-check-row');
      if (rows.length > 0) {
        const target = rows[Math.max(0, idx - 1)];
        target.classList.add('row-selected');
        target.querySelector('.ed-check-text')?.focus();
      }
    });

    row.append(handle, chk, txt, del);
    root.appendChild(row);
  }

  // ── Drag-and-drop: pointer events (mouse + touch), handle only ───────────────
  // Ghost floats with the pointer; other rows animate with translateY in real-time.
  let activeDrag = null;

  function endDrag() {
    if (!activeDrag) return;
    const { srcRow, allRows, ghost, srcIdx, tIdx } = activeDrag;
    activeDrag = null;
    allRows.forEach(r => { r.style.transition = ''; r.style.transform = ''; });
    srcRow.style.visibility = '';
    ghost.remove();
    if (tIdx !== srcIdx) reorderChecklist(srcRow.dataset.id, allRows[tIdx].dataset.id);
  }

  root.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (activeDrag) return;
      ev.preventDefault();

      const srcRow = handle.closest('.ed-check-row');
      if (!srcRow) return;

      syncChecklistFromDom();
      EditorHistory.flush();

      const allRows = Array.from(root.querySelectorAll('.ed-check-row'));
      const srcIdx  = allRows.indexOf(srcRow);
      const rects   = allRows.map(r => r.getBoundingClientRect());
      const srcRect = rects[srcIdx];
      const offsetY = ev.clientY - srcRect.top;
      const cardEl  = document.querySelector('#editor .editor-card');
      const cardBg  = cardEl ? getComputedStyle(cardEl).backgroundColor : '';

      const ghost = srcRow.cloneNode(true);
      Object.assign(ghost.style, {
        position: 'fixed',
        left: srcRect.left + 'px',
        top:  srcRect.top  + 'px',
        width: srcRect.width + 'px',
        margin: '0',
        zIndex: '9999',
        pointerEvents: 'none',
        background: cardBg || 'var(--surface)',
        boxShadow: '0 8px 28px rgba(0,0,0,.4)',
        borderRadius: '6px',
        opacity: '0.97',
        transform: 'scale(1.02)',
      });
      document.body.appendChild(ghost);

      srcRow.style.visibility = 'hidden';
      allRows.forEach((r, i) => {
        if (i !== srcIdx) r.style.transition = 'transform .15s ease';
      });

      activeDrag = { handle, srcRow, allRows, rects, srcIdx, tIdx: srcIdx, ghost, offsetY };
      handle.setPointerCapture(ev.pointerId);
    }, { passive: false });

    handle.addEventListener('pointermove', ev => {
      if (!activeDrag || activeDrag.handle !== handle) return;
      ev.preventDefault();

      const { ghost, allRows, rects, srcIdx, offsetY } = activeDrag;
      const ghostTop    = ev.clientY - offsetY;
      ghost.style.top   = ghostTop + 'px';
      const srcH        = rects[srcIdx].height;
      const ghostCenter = ghostTop + srcH / 2;

      // Closest row center → drop target (include srcIdx so ghost near origin = no-op)
      let tIdx = srcIdx, minDist = Infinity;
      allRows.forEach((_, i) => {
        const mid = rects[i].top + rects[i].height / 2;
        const d = Math.abs(ghostCenter - mid);
        if (d < minDist) { minDist = d; tIdx = i; }
      });
      activeDrag.tIdx = tIdx;

      // Shift rows to open gap at drop target
      allRows.forEach((r, i) => {
        if (i === srcIdx) return;
        let dy = 0;
        if (tIdx > srcIdx && i > srcIdx && i <= tIdx) dy = -srcH;
        if (tIdx < srcIdx && i >= tIdx && i < srcIdx) dy =  srcH;
        r.style.transform = dy ? `translateY(${dy}px)` : '';
      });
    }, { passive: false });

    handle.addEventListener('pointerup',     endDrag);
    handle.addEventListener('pointercancel', endDrag);
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
  if (isNoteEmpty(e)) return;
  const idx = State.notes.findIndex(n => n.id === e.id);
  if (idx >= 0) State.notes[idx] = JSON.parse(JSON.stringify(e));
  else State.notes.unshift(JSON.parse(JSON.stringify(e)));
  await saveNoteLocal(e);
  State.editingSnapshotTime = e.last_modified;  // prevent next commit from re-merging this save as "remote"
  State.editorDirty = true;
  $('#ed-status').textContent = 'Guardado';
  updateEditorMeta();
  if ($('#editor').hidden) renderGrid();
}

// Persist any uncommitted editor content immediately (used on close and when
// the app is hidden/backgrounded so a debounced save is never stranded).
function commitEditorIfDirty() {
  const e = State.editing;
  if (!e) return;
  syncChecklistFromDom();
  e.title = $('#ed-title')?.value || '';
  e.body  = $('#ed-body')?.value  || '';
  if (!isNoteEmpty(e) && noteContentHash(e) !== State.editorOpenSnapshot) {
    clearTimeout(saveTimer); saveTimer = null;
    commitEditor();
    State.editorOpenSnapshot = noteContentHash(e);
  }
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
  const modal = $('#editor');
  if (modal.hidden || modal._closing) return; // guard against double-close (popstate fires twice on edge gestures)
  modal._closing = true;

  detachKeyboardListener();
  clearTimeout(saveTimer);
  saveTimer = null;

  let noteWasEmpty = false;
  const editedId = State.editing?.id || null;
  if (State.editing) {
    syncChecklistFromDom();
    const e = State.editing;
    e.title = $('#ed-title')?.value || '';
    e.body  = $('#ed-body')?.value  || '';
    if (isNoteEmpty(e)) {
      noteWasEmpty = true;
      State.notes = State.notes.filter(n => n.id !== e.id);
      idb.del('notes', e.id).catch(() => {});
      renderGrid();
    } else if (noteContentHash(e) !== State.editorOpenSnapshot) {
      commitEditor();
    }
  }
  if (!fromPopState && history.state?.modal === 'editor') history.back();
  State.editing = null;

  // Keep the body locked (position:fixed + paddingRight) during the FLIP so
  // the grid never shifts horizontally. We restore scroll/unlock only when
  // the animation has finished in onCloseEnd.

  hidePopups();

  // Use the rect captured at openEditor (before lockBodyScroll) which is
  // the position the grid will have once the body is unlocked again.
  // Querying the live card now would give a position shifted by the
  // scrollbar-compensation padding that's still applied to body.
  // Prefer the live grid card so the note "falls into its place"; fall back to
  // the rect captured at open, then to the + FAB (new/empty notes).
  let originRect = null;
  if (editedId) {
    const freshCard = document.querySelector(`.note-card[data-id="${editedId}"]`);
    if (freshCard) {
      const r = freshCard.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) originRect = r;
    }
  }
  if (!originRect) originRect = State.editorOriginRect;
  if (!originRect) {
    const fab = document.getElementById('fab-new');
    if (fab) { const r = fab.getBoundingClientRect(); if (r.width > 0) originRect = r; }
  }
  State.editorOriginRect = null;

  const modalCard = modal.querySelector('.modal-card');
  const modalBg   = modal.querySelector('.modal-bg');

  let _closed = false;
  function onCloseEnd() {
    if (_closed) return;
    _closed = true;
    // Now unlock the body: this is the moment the grid would shift, but
    // since the modal is gone the user does not see the reflow.
    const savedScrollY = parseInt(document.body.dataset.scrollY || '0', 10);
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('--scroll-y');
    document.body.style.paddingRight = '';
    window.scrollTo(0, savedScrollY);
    modal.classList.remove('closing');
    modal.hidden = true;
    modal._closing = false;
    if (modalCard) { modalCard.style.cssText = ''; }
    if (modalBg)   { modalBg.style.transition = ''; modalBg.style.opacity = ''; }
    $('#ed-checklist-list').contentEditable = 'inherit';
    if (State.editorDirty) { State.editorDirty = false; renderGrid(); }
    // Restore the lifted-out card (renderGrid may have replaced it already).
    if (editedId) {
      const c = document.querySelector(`.note-card[data-id="${editedId}"]`);
      if (c) c.style.visibility = '';
    }
  }

  // Skip the FLIP when popstate fires (Android back gesture). Brave runs its
  // own page-back slide at the viewport level and our shrink-to-card on top
  // looks like a stutter/refresh. The system slide is the close animation in
  // that case; the FLIP only plays for in-app closes (X button, tap on backdrop,
  // Esc), where there is no competing animation.
  if (fromPopState) {
    onCloseEnd();
    return;
  }

  if (originRect && modalCard && !noteWasEmpty) {
    const cardRect = modalCard.getBoundingClientRect();
    const scaleX = Math.max(originRect.width  / cardRect.width,  0.01);
    const scaleY = Math.max(originRect.height / cardRect.height, 0.01);
    const tx = originRect.left + originRect.width  / 2 - (cardRect.left + cardRect.width  / 2);
    const ty = originRect.top  + originRect.height / 2 - (cardRect.top  + cardRect.height / 2);

    modalCard.style.animation = 'none'; // override the CSS keyframe
    modalCard.style.overflow = 'hidden';
    modalCard.style.pointerEvents = 'none';
    // Scrim fades; the card keeps its content visible as it shrinks into place.
    if (modalBg) { modalBg.style.animation = 'none'; modalBg.style.transition = 'opacity 0.2s ease'; modalBg.style.opacity = '0'; }

    modalCard.getBoundingClientRect(); // force reflow

    modalCard.style.transition = 'transform 0.24s cubic-bezier(0.2,0,0,1)';
    modalCard.style.transformOrigin = 'center center';
    modalCard.style.transform = `translate(${tx}px, ${ty}px) scale(${scaleX}, ${scaleY})`;

    const onTrans = (e) => {
      if (e.propertyName !== 'transform') return;
      modalCard.removeEventListener('transitionend', onTrans);
      onCloseEnd();
    };
    modalCard.addEventListener('transitionend', onTrans);
    setTimeout(onCloseEnd, 320); // fallback
  } else {
    modal.classList.add('closing');
    modalCard?.addEventListener('animationend', onCloseEnd, { once: true });
    setTimeout(onCloseEnd, 200); // fallback
  }
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
    sort_order: Date.now() + 1, // goes to top of grid
    categories: State.view.startsWith('cat:') ? [State.view.slice(4)] : [],
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
    EditorHistory.flush();
    State.editing.pinned = !State.editing.pinned;
    scheduleSave(); updateEditorMeta();
  });
  $('#ed-lock').addEventListener('click', () => {
    EditorHistory.flush();
    State.editing.locked = !State.editing.locked;
    scheduleSave(); updateEditorMeta();
  });
  $('#ed-archive').addEventListener('click', async () => {
    EditorHistory.flush();
    const e = State.editing;
    if (!e) return;
    syncChecklistFromDom();
    e.title = $('#ed-title')?.value || '';
    e.body  = $('#ed-body')?.value  || '';
    const wasArchived = e.archived;
    e.archived = !wasArchived;
    e.last_modified = Date.now();
    const idx = State.notes.findIndex(n => n.id === e.id);
    if (idx >= 0) State.notes[idx] = JSON.parse(JSON.stringify(e));
    else State.notes.unshift(JSON.parse(JSON.stringify(e)));
    await saveNoteLocal(e);
    const noteId = e.id;
    State.editing = null;
    closeEditor();
    render();
    if (!wasArchived) {
      showUndoToast('Nota archivada', () => {
        const n = State.notes.find(x => x.id === noteId);
        if (n) { n.archived = false; n.last_modified = Date.now(); saveNoteLocal(n); render(); }
      });
    }
  });
  $('#ed-checklist').addEventListener('click', () => {
    EditorHistory.flush();
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
    const popup = document.getElementById('popup-more');
    if (popup) popup.style.background = State.editing?.color || '';
  });

  // Add menu (+)
  $('#ed-add').addEventListener('click', (ev) => {
    showPopupAt('#popup-add', ev.currentTarget);
  });

  // Undo / redo
  $('#ed-undo').addEventListener('click', () => EditorHistory.undo());
  $('#ed-redo').addEventListener('click', () => EditorHistory.redo());
  $('#ed-delete').addEventListener('click', async () => {
    const e = State.editing;
    if (!e) return;
    if (!(await window.customConfirm('¿Mover a la papelera?'))) return;
    const noteId = e.id;
    const snapshot = JSON.parse(JSON.stringify(e));
    syncChecklistFromDom();
    e.title = $('#ed-title')?.value || '';
    e.body  = $('#ed-body')?.value  || '';
    e.trashed_at = Date.now();
    e.last_modified = Date.now();
    // Update State.notes synchronously, then close UI immediately
    const idx = State.notes.findIndex(n => n.id === e.id);
    if (idx >= 0) State.notes[idx] = JSON.parse(JSON.stringify(e));
    State.editing = null;
    closeEditor();
    render();
    showUndoToast('Nota eliminada', () => {
      const n = State.notes.find(x => x.id === noteId);
      const target = n || (() => { State.notes.unshift(JSON.parse(JSON.stringify(snapshot))); return State.notes[0]; })();
      target.trashed_at = null;
      target.last_modified = Date.now();
      saveNoteLocal(target);
      render();
    });
    // Persist and sync in background (non-blocking)
    saveNoteLocal(e);
    apiTrashNote(noteId).catch(() => {});
  });

  // Color picker
  $('#ed-color').addEventListener('click', (ev) => {
    showPopupAt('#popup-color', ev.currentTarget);
  });
  $$('#popup-color .color-swatch').forEach(s => {
    s.addEventListener('click', () => {
      EditorHistory.flush();
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
  $('#ed-categories').addEventListener('click', () => {
    renderCategoriesPopup();
    openCatsModal();
  });
  $('#cats-modal-bg').addEventListener('click', closeCatsModal);
  $('#cats-modal-close').addEventListener('click', closeCatsModal);
  $('#popup-new-cat-btn').addEventListener('click', async () => {
    const inp = $('#popup-new-cat');
    const name = inp.value.trim();
    if (!name) return;
    const cat = {
      id: crypto.randomUUID(),
      owner_email: getUserEmail(),
      name,
      icon: '🏷️',
      color: '#5B3082',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    State.categories.push(cat);
    await saveCategoryLocal(cat);
    try { await apiCreateCat({ id: cat.id, name: cat.name, icon: cat.icon, color: cat.color }); } catch {}
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
    EditorHistory.flush();
    State.editing.reminder_at = new Date(v).getTime();
    State.editing.reminder_sent = false;
    hidePopups();
    scheduleSave();
    updateEditorMeta();
    // ensure push subscription is set up for reminders to work in background
    ensurePushSubscription().catch(() => {});
  });
  $('#popup-reminder-clear').addEventListener('click', () => {
    EditorHistory.flush();
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

  // Paste handler: images get uploaded; text always stripped to plain
  $('#editor').addEventListener('paste', async (ev) => {
    if (!State.editing) return;
    const items = [...(ev.clipboardData?.items || [])];
    const imageItem = items.find(it => it.type.startsWith('image/'));
    if (imageItem) {
      ev.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const blob = await resizeImage(file, 1600, 0.85);
      try {
        const att = await apiUploadAttachment(State.editing.id, blob, 'image');
        State.editing.attachments = (State.editing.attachments || []).concat([{ ...att, note_id: State.editing.id }]);
        renderAttachments();
        scheduleSave();
      } catch (err) { alert(err.message); }
      return;
    }
    // Strip formatting: always paste plain text
    const target = document.activeElement;
    if (!target || (!target.isContentEditable && target.tagName !== 'TEXTAREA' && target.tagName !== 'INPUT')) return;
    const plain = ev.clipboardData.getData('text/plain');
    if (!plain) return;
    ev.preventDefault();
    if (target.isContentEditable) {
      document.execCommand('insertText', false, plain);
    } else {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      target.value = target.value.slice(0, start) + plain + target.value.slice(end);
      target.selectionStart = target.selectionEnd = start + plain.length;
      target.dispatchEvent(new Event('input', { bubbles: true }));
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

  // close — the back/close button always closes
  $('#ed-close')?.addEventListener('click', () => closeEditor());
  // Backdrop: only close on a genuine click that STARTED on the backdrop. A text
  // selection drag that begins inside the note and is released on the backdrop
  // must NOT close the editor.
  let _editorPressOnBg = false;
  $('#editor').addEventListener('pointerdown', (e) => {
    _editorPressOnBg = e.target.classList.contains('modal-bg') || e.target === $('#editor');
  });
  $('#editor').addEventListener('click', (e) => {
    const onBg = e.target.classList.contains('modal-bg') || e.target === e.currentTarget;
    if (onBg && _editorPressOnBg) closeEditor();
  });
  $('#ed-title').addEventListener('focus',   () => EditorHistory.mark());
  $('#ed-body').addEventListener('focus',    () => EditorHistory.mark());
  $('#ed-title').addEventListener('input',   () => { EditorHistory.schedule(); scheduleSave(); });
  $('#ed-body').addEventListener('input',    () => { autoGrow($('#ed-body')); EditorHistory.schedule(); scheduleSave(); });
  $('#ed-title').addEventListener('blur',    commitEditor);
  $('#ed-body').addEventListener('blur',     commitEditor);

  // Checklist container — bound ONCE here, not inside renderChecklist
  const cl = $('#ed-checklist-list');
  cl.addEventListener('focusin', () => EditorHistory.mark());
  cl.addEventListener('input',   () => { syncChecklistFromDom(); EditorHistory.schedule(); scheduleSave(); });
  cl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const e = State.editing;
      if (!e) return;
      EditorHistory.flush();
      syncChecklistFromDom();
      e.checklist_items = e.checklist_items || [];
      const curRow = ev.target.closest?.('.ed-check-row');
      const curId = curRow?.dataset.id;
      const curIdx = curId ? e.checklist_items.findIndex(x => x.id === curId) : -1;
      const curItem = curIdx >= 0 ? e.checklist_items[curIdx] : null;

      // Split text at cursor: left stays in current item, right goes to new item
      let textAfter = '';
      if (ev.target.matches('.ed-check-text') && curItem) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const txtEl = ev.target;
          const before = document.createRange();
          before.selectNodeContents(txtEl);
          before.setEnd(range.startContainer, range.startOffset);
          const after = document.createRange();
          after.selectNodeContents(txtEl);
          after.setStart(range.endContainer, range.endOffset);
          curItem.text = before.toString();
          textAfter   = after.toString();
        }
      }

      const newItem = { id: crypto.randomUUID(), text: textAfter, done: false, order: 0 };
      if (curIdx >= 0) e.checklist_items.splice(curIdx + 1, 0, newItem);
      else e.checklist_items.push(newItem);
      e.checklist_items.forEach((it, i) => { it.order = i; });
      renderChecklist();
      scheduleSave();
      const rows = cl.querySelectorAll('.ed-check-text');
      const target = rows[Math.max(0, curIdx + 1)];
      if (target) {
        target.focus();
        textAfter ? placeCursorAtStart(target) : placeCursorAtEnd(target);
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
      }
      return;
    }
    if (ev.key === 'Backspace' && ev.target.matches('.ed-check-text')) {
      if (ev.target.textContent !== '') return;
      ev.preventDefault();
      const e = State.editing;
      if (!e) return;
      EditorHistory.flush();
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
  // Mobile: beforeinput fires more reliably than keydown for backspace on virtual keyboard
  cl.addEventListener('beforeinput', (ev) => {
    if (ev.inputType !== 'deleteContentBackward') return;
    if (!ev.target.matches('.ed-check-text')) return;
    if (ev.isComposing) return;
    if (ev.target.textContent !== '') return;
    ev.preventDefault();
    const e = State.editing;
    if (!e) return;
    EditorHistory.flush();
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
  });
}

function renderCategoriesPopup() {
  const list = $('#cats-modal-list');
  list.innerHTML = '';
  const me = getUserEmail();
  const own = State.categories.filter(c => c.owner_email === me);
  for (const c of own) {
    const lbl = document.createElement('label');
    lbl.className = 'cats-modal-row';
    const checked = (State.editing?.categories || []).includes(c.id);
    lbl.innerHTML = `<input type="checkbox" data-id="${c.id}" ${checked ? 'checked' : ''}>
                     <span class="cat-icon-display">${c.icon || '🏷️'}</span>
                     <span>${escapeHtml(c.name)}</span>`;
    lbl.querySelector('input').addEventListener('change', (e) => {
      EditorHistory.flush();
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
  if (!own.length) list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:12px 0">No tienes categorías aún.</p>';
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

// ── icon picker popup (shared, used in drawer) ───────────────────────────────
function openIconPicker(catId, anchorBtn) {
  const popup = $('#cat-icon-popup');
  popup.innerHTML = CAT_ICONS.map(em => `<button class="cat-icon-opt" data-icon="${em}">${em}</button>`).join('');
  popup.dataset.catId = catId;

  const rect = anchorBtn.getBoundingClientRect();
  popup.hidden = false;
  const popW = 256, popH = 140;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top  = `${Math.max(8, top)}px`;

  popup.querySelectorAll('.cat-icon-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = State.categories.find(x => x.id === catId);
      if (cat) {
        cat.icon = btn.dataset.icon;
        cat.updated_at = Date.now();
        anchorBtn.textContent = cat.icon;
        await saveCategoryLocal(cat);
        try { await apiUpdateCat(catId, { icon: cat.icon }); } catch {}
        renderCategoriesStrip();
      }
      popup.hidden = true;
    });
  });
}

document.addEventListener('click', () => {
  const popup = $('#cat-icon-popup');
  if (popup && !popup.hidden) popup.hidden = true;
});

// ── cats modal ───────────────────────────────────────────────────────────────
function openCatsModal() {
  lockBodyScroll();
  $('#cats-modal').hidden = false;
}
function closeCatsModal() {
  $('#cats-modal').hidden = true;
  unlockBodyScroll();
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
function openBulkCatsModal() {
  const list = $('#bulk-cats-list');
  list.innerHTML = '';
  const me = getUserEmail();
  const own = State.categories.filter(c => c.owner_email === me);
  if (!own.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">No tienes categorías aún.</p>';
  }
  for (const c of own) {
    const lbl = document.createElement('label');
    lbl.className = 'bulk-cat-row';
    const allHave = [...State.selected].every(id => (State.notes.find(n => n.id === id)?.categories || []).includes(c.id));
    lbl.innerHTML = `<input type="checkbox" ${allHave ? 'checked' : ''}>
      <span class="cat-icon-display">${c.icon || '🏷️'}</span>
      <span>${escapeHtml(c.name)}</span>`;
    lbl.querySelector('input').addEventListener('change', (e) => {
      for (const nid of State.selected) {
        const n = State.notes.find(x => x.id === nid);
        if (!n) continue;
        n.categories = n.categories || [];
        if (e.target.checked) { if (!n.categories.includes(c.id)) n.categories.push(c.id); }
        else { n.categories = n.categories.filter(x => x !== c.id); }
        n.last_modified = Date.now();
        saveNoteLocal(n);
      }
    });
    list.appendChild(lbl);
  }
  $('#bulk-cats-modal').hidden = false;
}

function closeBulkCatsModal() {
  $('#bulk-cats-modal').hidden = true;
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
    renderPasskeyList();
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
      icon: '🏷️',
      color: '#5B3082',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    State.categories.push(cat);
    await saveCategoryLocal(cat);
    try { await apiCreateCat({ id: cat.id, name, icon: cat.icon, color: cat.color }); } catch {}
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

  function relativeTime(ts) {
    if (!ts) return 'Nunca';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 2)   return 'Hace un momento';
    if (m < 60)  return `Hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `Hace ${h}h`;
    const d = Math.floor(h / 24);
    if (d < 30)  return `Hace ${d}d`;
    const mo = Math.floor(d / 30);
    return `Hace ${mo} mes${mo > 1 ? 'es' : ''}`;
  }

  async function renderPasskeyList() {
    const container = $('#drawer-passkey-list');
    if (!container) return;
    container.innerHTML = '<p style="padding:4px 12px;font-size:13px;color:var(--text2)">Cargando…</p>';
    try {
      const passkeys = await apiListPasskeys();
      if (!passkeys.length) {
        container.innerHTML = '<p style="padding:4px 12px;font-size:13px;color:var(--text2)">Sin passkeys registradas.</p>';
        return;
      }
      container.innerHTML = '';
      passkeys.forEach(pk => {
        const row = document.createElement('div');
        row.className = 'passkey-row';
        const credId = pk.credential_id;
        const name = pk.device_name || 'Passkey';
        const lastUsed = pk.last_used_at ? relativeTime(pk.last_used_at) : 'Nunca';
        const created  = pk.created_at  ? relativeTime(pk.created_at)  : '';
        row.innerHTML = `
          <div style="flex:1;min-width:0">
            <div class="passkey-name" title="${credId}">${name}</div>
            <div class="passkey-date">Uso: ${lastUsed} · Creada: ${created}</div>
          </div>
          <button class="passkey-btn" data-action="rename" title="Renombrar">${PENCIL_SVG}</button>
          <button class="passkey-btn" data-action="delete" title="Eliminar">${TRASH_SVG}</button>
        `;
        row.querySelector('[data-action="rename"]').addEventListener('click', () => {
          const nameDiv  = row.querySelector('.passkey-name');
          const dateDiv  = row.querySelector('.passkey-date');
          const renameBtn = row.querySelector('[data-action="rename"]');
          const deleteBtn = row.querySelector('[data-action="delete"]');
          const input = document.createElement('input');
          input.className = 'passkey-rename-input';
          input.value = name;
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'passkey-btn';
          confirmBtn.title = 'Guardar';
          confirmBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          nameDiv.replaceWith(input);
          dateDiv.style.display = 'none';
          renameBtn.replaceWith(confirmBtn);
          deleteBtn.style.display = 'none';
          requestAnimationFrame(() => { input.focus(); input.select(); });
          let saved = false;
          const save = async () => {
            if (saved) return;
            saved = true;
            const newName = input.value.trim() || 'Passkey';
            await apiRenamePasskey(credId, newName).catch(() => {});
            renderPasskeyList();
          };
          confirmBtn.addEventListener('click', save);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
          input.addEventListener('keydown', e => { if (e.key === 'Escape') renderPasskeyList(); });
        });
        row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
          const passkeys2 = await apiListPasskeys().catch(() => []);
          if (passkeys2.length <= 1) {
            alert('No puedes eliminar tu unica passkey. Agrega otra primero.');
            return;
          }
          if (!confirm(`Eliminar "${name}"?`)) return;
          await apiDeletePasskey(credId).catch(() => {});
          renderPasskeyList();
        });
        container.appendChild(row);
      });
    } catch (e) {
      container.innerHTML = `<p style="padding:4px 12px;font-size:13px;color:var(--danger,#f87171)">${e.message}</p>`;
    }
  }

  $('#drawer-add-passkey')?.addEventListener('click', async () => {
    const ok = await doRegisterPasskey();
    if (ok) renderPasskeyList();
    else alert('No se pudo registrar la passkey.');
  });

  $('#drawer-test-push').addEventListener('click', async () => {
    try {
      await ensurePushSubscription();
      alert('Notificaciones activas');
    } catch (e) { alert(e.message); }
  });

  // current user
  $('#drawer-user').textContent = getUserEmail() || '—';

  $('#drawer-force-sync')?.addEventListener('click', async () => {
    await idb.setMeta('lastSyncedAt', 0);
    const { changed } = await pull();
    State.notes = await idb.getAll('notes');
    State.categories = await idb.getAll('categories');
    render();
    alert(`Sincronización completa: ${State.notes.length} notas cargadas.`);
  });
  $('#drawer-logout')?.addEventListener('click', () => window.logout());
}

// ── sync status indicator ────────────────────────────────────────────────────
async function updateSyncStatus() {
  const btn = $('#sync-status');
  if (!btn) return;
  const online = navigator.onLine !== false;
  let queueLen = 0;
  try { queueLen = (await idb.peekQueue()).length; } catch {}
  let state, label;
  if (!online && queueLen > 0)      { state = 'pending';  label = `${queueLen} pendiente${queueLen !== 1 ? 's' : ''}`; }
  else if (!online)                 { state = 'offline';  label = 'Sin conexión'; }
  else if (isPushing() || queueLen) { state = 'syncing';  label = 'Sincronizando'; }
  else                              { state = 'synced';   label = 'Sincronizado'; }
  btn.dataset.state = state;
  const lbl = btn.querySelector('.sync-label');
  if (lbl) lbl.textContent = label;

  const popup = $('#popup-sync-status');
  if (popup && !popup.hidden) {
    $('#sync-detail-state').textContent = label;
    $('#sync-detail-queue').textContent = String(queueLen);
    const last = await idb.getMeta('lastSyncedAt');
    $('#sync-detail-last').textContent = last ? new Date(last).toLocaleString() : '—';
  }
}

// ── search + nav ─────────────────────────────────────────────────────────────
function bindUI() {
  $('#search').addEventListener('input', (e) => {
    State.search = e.target.value;
    renderGrid();
  });
  $('#btn-new')?.addEventListener('click', openNew);

  $('#search-help')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const popup = $('#popup-search-help');
    if (!popup) return;
    if (!popup.hidden) { hidePopups(); return; }
    showPopupAt('#popup-search-help', ev.currentTarget);
  });

  $('#sync-status')?.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const popup = $('#popup-sync-status');
    if (!popup) return;
    if (!popup.hidden) { hidePopups(); return; }
    await updateSyncStatus(); // refresh detail before showing
    showPopupAt('#popup-sync-status', ev.currentTarget);
  });

  $('#sync-retry')?.addEventListener('click', async () => {
    await flushQueue();
    await updateSyncStatus();
  });

  window.addEventListener('notes-sync-state', updateSyncStatus);
  window.addEventListener('online',  updateSyncStatus);
  window.addEventListener('offline', updateSyncStatus);
  updateSyncStatus();

  // Restore the desktop sidebar state (persists until the user toggles it),
  // without animating on load.
  if (window.innerWidth >= 900 && localStorage.getItem('notes_sidebar_open') === '1') {
    const sb = document.getElementById('sidebar');
    document.body.style.transition = 'none'; if (sb) sb.style.transition = 'none';
    document.body.classList.add('sidebar-open');
    document.body.offsetWidth; // reflow so the next change is the only animated one
    document.body.style.transition = ''; if (sb) sb.style.transition = '';
  }

  // Sidebar toggle
  $('#sidebar-toggle')?.addEventListener('click', () => {
    const willOpen = !document.body.classList.contains('sidebar-open');
    if (willOpen) openSidebar(); else closeSidebar();
    if (window.innerWidth >= 900) localStorage.setItem('notes_sidebar_open', willOpen ? '1' : '0');
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
  initSidebarSwipe();

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
  $('#select-cats')?.addEventListener('click', () => openBulkCatsModal());
  $('#bulk-cats-close')?.addEventListener('click', () => closeBulkCatsModal());
  $('#bulk-cats-bg')?.addEventListener('click', () => closeBulkCatsModal());
  $('#select-archive')?.addEventListener('click', async () => {
    const ids = [...State.selected];
    const unarchiving = State.view === 'archive';
    const targetVal = !unarchiving;
    for (const id of ids) {
      const n = State.notes.find(x => x.id === id);
      if (!n) continue;
      n.archived = targetVal; n.last_modified = Date.now();
      await saveNoteLocal(n);
    }
    exitSelectMode(); render();
    const verb = unarchiving ? 'desarchivada' : 'archivada';
    const verbP = unarchiving ? 'desarchivadas' : 'archivadas';
    const label = ids.length === 1 ? `Nota ${verb}` : `${ids.length} notas ${verbP}`;
    showUndoToast(label, async () => {
      for (const id of ids) {
        const n = State.notes.find(x => x.id === id);
        if (n) { n.archived = !targetVal; n.last_modified = Date.now(); await saveNoteLocal(n); }
      }
      render();
    });
  });
  $('#select-delete')?.addEventListener('click', async () => {
    const ids = [...State.selected];
    if (!(await window.customConfirm(`¿Mover ${ids.length} nota(s) a la papelera?`))) return;
    const snapshots = ids.map(id => {
      const n = State.notes.find(x => x.id === id);
      return n ? JSON.parse(JSON.stringify(n)) : null;
    }).filter(Boolean);
    const ts = Date.now();
    for (const id of ids) {
      const n = State.notes.find(x => x.id === id);
      if (!n) continue;
      n.trashed_at = ts; n.last_modified = ts;
    }
    exitSelectMode(); render();
    // Persist and sync in background
    for (const id of ids) {
      const n = State.notes.find(x => x.id === id);
      if (n) { saveNoteLocal(n); apiTrashNote(id).catch(() => {}); }
    }
    const label = ids.length === 1 ? 'Nota eliminada' : `${ids.length} notas eliminadas`;
    showUndoToast(label, async () => {
      for (const snap of snapshots) {
        const n = State.notes.find(x => x.id === snap.id);
        const target = n || (() => { State.notes.unshift(JSON.parse(JSON.stringify(snap))); return State.notes[0]; })();
        target.trashed_at = null;
        target.last_modified = Date.now();
        await saveNoteLocal(target);
      }
      render();
    });
  });

  // Lightbox
  $('#lightbox-bg').addEventListener('click', closeLightbox);
  $('#lightbox-img').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', e => {
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !$('#editor').hidden) {
      e.preventDefault();
      if (e.shiftKey) EditorHistory.redo();
      else            EditorHistory.undo();
      return;
    }
    if (e.key === 'y' && (e.ctrlKey || e.metaKey) && !$('#editor').hidden) {
      e.preventDefault();
      EditorHistory.redo();
      return;
    }
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) { closeLightbox(); return; }
    if (!$('#bulk-cats-modal').hidden) { closeBulkCatsModal(); return; }
    if (!$('#confirm-modal').hidden) { $('#confirm-cancel').click(); return; }
    if (!$('#pin-modal').hidden) { $('#pin-cancel').click(); return; }
    if ($$('.popup').some(p => !p.hidden)) { hidePopups(); return; }
    if (State.selectMode) { exitSelectMode(); return; }
    if (!$('#editor').hidden) { closeEditor(); return; }
  });

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
    if (!$('#lightbox').hidden) {
      closeLightbox(true);
      return;
    }
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
function htmlToText(str) {
  if (!str || !str.includes('<')) return str;
  const div = document.createElement('div');
  div.innerHTML = str;
  // Insert newline after each block/list element so items don't merge
  div.querySelectorAll('li, p, tr, div, br, h1, h2, h3, h4').forEach(el => {
    el.after(document.createTextNode('\n'));
  });
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
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

// ── Login (called from inline handlers in #loginScreen) ──────────────────────
// ── Login passkey helpers ─────────────────────────────────────────────────────
function _b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function initLoginScreen() {
  document.getElementById('btnEmailLogin')?.addEventListener('click', doEmailLogin);
  document.getElementById('loginEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') doEmailLogin(); });
  document.getElementById('btnPasskeyLogin')?.addEventListener('click', doPasskeyLogin);

  // Passkey setup overlay — registration is mandatory, no skip
  document.getElementById('btnSetupPasskey')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSetupPasskey');
    const errEl = document.getElementById('setupError');
    btn.disabled = true;
    btn.textContent = 'Registrando…';
    if (errEl) errEl.textContent = '';
    const ok = await doRegisterPasskey();
    if (ok) {
      document.getElementById('passkeySetup').classList.add('hidden');
      init();
    } else {
      btn.disabled = false;
      btn.textContent = 'Reintentar';
      if (errEl) errEl.textContent = 'No se pudo registrar. Intenta de nuevo.';
    }
  });
}

async function doPasskeyLogin() {
  const btn   = document.getElementById('btnPasskeyLogin');
  const errEl = document.getElementById('loginError');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
  if (errEl) errEl.textContent = '';
  try {
    const credPromise = navigator.credentials.get({
      mediation: 'required',
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        timeout: 60000,
        userVerification: 'required',
        rpId: 'kisushotto.com',
      },
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo de espera agotado. Intenta de nuevo.')), 65000));
    const assertion = await Promise.race([credPromise, timeout]);
    if (!assertion) throw new Error('Cancelado');
    const credId = _b64urlEncode(assertion.rawId);
    const res = await fetch(`${cfg.base()}/auth/passkey/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token()}` },
      body: JSON.stringify({ credentialId: credId }),
    });
    if (!res.ok) throw new Error('Passkey no encontrada. Inicia sesion con tu email primero.');
    const { email } = await res.json();
    localStorage.setItem('notes_user', email);
    localStorage.setItem('notes_webauthn_id', credId);
    document.getElementById('loginScreen').classList.add('hidden');
    init();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar con passkey'; }
    if (errEl) errEl.textContent = e.message || 'Error de autenticacion';
  }
}

async function doEmailLogin() {
  const email = (document.getElementById('loginEmail')?.value || '').trim().toLowerCase();
  const errEl = document.getElementById('loginError');
  const emailBtn = document.getElementById('btnEmailLogin');
  if (!email || !email.includes('@')) {
    if (errEl) errEl.textContent = 'Ingresa un email valido.';
    return;
  }
  if (errEl) errEl.textContent = '';
  if (emailBtn) { emailBtn.disabled = true; emailBtn.textContent = 'Verificando…'; }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const chk = await fetch(`${cfg.base()}/auth/passkey/check`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token()}` },
      body: JSON.stringify({ email }),
    });
    clearTimeout(t);
    if (chk.ok) {
      const { hasPasskey } = await chk.json();
      if (hasPasskey) {
        if (emailBtn) { emailBtn.disabled = false; emailBtn.textContent = 'Continuar con email'; }
        doPasskeyLogin();
        return;
      }
    }
  } catch {
    // si el check falla o timeout, continuar con email
  }

  if (emailBtn) { emailBtn.disabled = false; emailBtn.textContent = 'Continuar con email'; }
  localStorage.setItem('notes_user', email);
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('passkeySetup').classList.remove('hidden');
}

// ONE credential for both login and note-unlock
async function doRegisterPasskey() {
  const email = getUserEmail();
  if (!email) return false;
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Notas KS', id: 'kisushotto.com' },
        user: { id: new TextEncoder().encode(email), name: email, displayName: email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
        timeout: 60000,
        attestation: 'none',
      },
    });
    if (!cred) return false;
    const credId = _b64urlEncode(cred.rawId);
    // Register for app login
    const res = await fetch(`${cfg.base()}/auth/passkey/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.token()}`, 'X-User-Email': email },
      body: JSON.stringify({ email, credentialId: credId }),
    });
    if (!res.ok) { console.error('passkey register failed', res.status, await res.text()); return false; }
    // Register same credential for note unlock
    await apiRegWebauthn(credId, null);
    localStorage.setItem('notes_webauthn_id', credId);
    return true;
  } catch (e) {
    console.warn('Passkey registration failed', e);
    return false;
  }
}

window.logout = function() {
  localStorage.removeItem('notes_user');
  localStorage.removeItem('notes_unlocked_until');
  location.reload();
};

init();
