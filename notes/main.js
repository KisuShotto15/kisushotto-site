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

const State = {
  user: null,
  notes: [],
  categories: [],
  view: 'all',          // 'all' | 'archive' | 'trash' | 'shared' | 'locked' | 'cat:<id>'
  search: '',
  editing: null,        // note being edited
  attachUrls: {},       // attId -> object URL
  pinPending: null,     // resolver fn while PIN modal open
};

let saveTimer = null;

// ── init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!getUserEmail()) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center"><h2>No estás autenticado</h2><p>Abre la app desde el dominio protegido.</p></div>';
    return;
  }

  // SW
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }

  // Online indicator
  updateNetBanner(navigator.onLine);
  onConnectionChange(updateNetBanner);

  // Local-first
  await loadFromIDB();
  render();

  // Network
  try {
    State.user = await apiGetMe();
    await pull();
    await loadFromIDB();
    render();
  } catch (e) {
    console.warn('initial sync failed', e);
  }

  // Periodic pull
  setInterval(async () => {
    if (!navigator.onLine) return;
    try { await pull(); await loadFromIDB(); render(); } catch {}
  }, 30000);

  bindUI();

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

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
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
    if (v === 'shared')  return n.owner_email !== me;
    if (v === 'locked')  return !!n.locked && n.owner_email === me;
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

function renderCategoriesStrip() {
  const anchor = $('#cat-list-anchor');
  if (!anchor) return;
  // remove any existing dynamic pills (siblings between divider and add btn)
  const wrap = $('#cat-strip');
  wrap.querySelectorAll('.cat-pill[data-cat-id]').forEach(el => el.remove());

  const me = getUserEmail();
  const ownCats = State.categories.filter(c => c.owner_email === me);
  for (const c of ownCats) {
    const btn = document.createElement('button');
    btn.className = 'cat-pill';
    btn.dataset.cat = `cat:${c.id}`;
    btn.dataset.catId = c.id;
    btn.style.borderColor = c.color;
    btn.textContent = c.name;
    if (State.view === `cat:${c.id}`) btn.classList.add('active');
    btn.addEventListener('click', () => setView(`cat:${c.id}`));
    anchor.parentNode.insertBefore(btn, anchor);
  }

  // active state for static pills
  $$('.cat-pill[data-cat]').forEach(p => {
    p.classList.toggle('active', p.dataset.cat === State.view);
  });
}

function renderDrawerCats() {
  const root = $('#drawer-cat-list');
  if (!root) return;
  root.innerHTML = '';
  const me = getUserEmail();
  const own = State.categories.filter(c => c.owner_email === me);
  for (const c of own) {
    const row = document.createElement('div');
    row.className = 'drawer-cat-row';
    row.innerHTML = `
      <span class="drawer-cat-dot" style="background:${c.color}"></span>
      <input class="drawer-cat-name" value="${escapeHtml(c.name)}" data-id="${c.id}">
      <input type="color" value="${c.color}" data-id="${c.id}" data-field="color">
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
      if (!confirm('¿Eliminar categoría? Las notas no se borran.')) return;
      try { await apiDeleteCat(id); } catch {}
      State.categories = State.categories.filter(c => c.id !== id);
      await idb.del('categories', id);
      renderCategoriesStrip();
      renderDrawerCats();
      render();
    });
  });
}

function noteCardHtml(n) {
  const me = getUserEmail();
  const isShared = n.owner_email !== me;
  const colored = !!n.color;
  const cls = `note-card${colored ? ' colored' : ''}`;
  const style = colored ? `style="background:${n.color}"` : '';
  let body = '';
  if (n.locked && n.owner_email === me && !isSessionUnlocked()) {
    body = `<div class="nc-body" style="display:flex;align-items:center;gap:8px;color:var(--muted)"><span class="nc-locked">🔒</span> Nota protegida</div>`;
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
  const lockBadge = n.locked ? `<span class="nc-locked">🔒</span>` : '';
  const reminderBadge = n.reminder_at ? `<span>⏰ ${fmtDate(n.reminder_at)}</span>` : '';

  return `
    <article class="${cls}" ${style} data-id="${n.id}" onclick="">
      ${n.pinned ? '<span class="nc-pin">📌</span>' : ''}
      ${n.title ? `<div class="nc-title">${escapeHtml(n.title)}</div>` : ''}
      ${imgs}
      ${body}
      <div class="nc-meta">${catTags}${sharedBadge}${lockBadge}${reminderBadge}</div>
    </article>
  `;
}

function renderGrid() {
  const notes = getCurrentNotes();
  const pinned = notes.filter(n => n.pinned);
  const others = notes.filter(n => !n.pinned);

  $('#pinned-section').hidden = pinned.length === 0 || State.view === 'trash';
  $('#grid-pinned').innerHTML = pinned.map(noteCardHtml).join('');
  $('#grid-others').innerHTML = others.map(noteCardHtml).join('');

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

  // Wire card clicks
  $$('.note-card').forEach(card => {
    card.addEventListener('click', (ev) => {
      const chkLine = ev.target.closest('.nc-checklist-line');
      if (chkLine) {
        ev.stopPropagation();
        const n = State.notes.find(x => x.id === card.dataset.id);
        if (!n || !n.checklist_items) return;
        const idx = parseInt(chkLine.dataset.idx, 10);
        const item = n.checklist_items[idx];
        if (!item) return;
        item.done = !item.done;
        n.last_modified = Date.now();
        saveNoteLocal(n);
        chkLine.classList.toggle('done', item.done);
        const chk = chkLine.querySelector('input[type="checkbox"]');
        if (chk) chk.checked = item.done;
        return;
      }
      const n = State.notes.find(x => x.id === card.dataset.id);
      if (n) openCard(n);
    });
  });

  // Lazy-load attachments
  $$('img.nc-image-thumb[data-att]').forEach(async img => {
    const id = img.dataset.att;
    if (!id) return;
    if (State.attachUrls[id]) { img.src = State.attachUrls[id]; return; }
    try {
      const url = await apiAttachmentBlobUrl(id);
      State.attachUrls[id] = url;
      img.src = url;
    } catch {}
  });
  $$('audio.nc-audio[data-att]').forEach(async audio => {
    const id = audio.dataset.att;
    if (!id) return;
    if (State.attachUrls[id]) { audio.src = State.attachUrls[id]; return; }
    try {
      const url = await apiAttachmentBlobUrl(id);
      State.attachUrls[id] = url;
      audio.src = url;
    } catch {}
  });
}

function render() {
  renderCategoriesStrip();
  renderDrawerCats();
  renderGrid();
}

// ── view state ───────────────────────────────────────────────────────────────
function setView(v) {
  State.view = v;
  render();
}

// ── card click → editor or PIN ───────────────────────────────────────────────
async function openCard(n) {
  const me = getUserEmail();
  if (n.locked && n.owner_email === me && !isSessionUnlocked()) {
    const ok = await promptUnlock();
    if (!ok) return;
  }
  openEditor(n);
}

// ── editor ───────────────────────────────────────────────────────────────────
function openEditor(n) {
  State.editing = JSON.parse(JSON.stringify(n));
  const e = State.editing;

  $('#editor').hidden = false;
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

  setTimeout(() => $('#ed-title').focus(), 50);
}

function updateEditorMeta() {
  const e = State.editing;
  if (!e) return;
  const tags = [];
  if (e.pinned)      tags.push('<span class="ed-meta-tag">📌 Fijada</span>');
  if (e.locked)      tags.push('<span class="ed-meta-tag">🔒 Protegida</span>');
  if (e.archived)    tags.push('<span class="ed-meta-tag">📦 Archivada</span>');
  if (e.reminder_at) tags.push(`<span class="ed-meta-tag">⏰ ${fmtDate(e.reminder_at)}</span>`);
  if (e.shares?.length) tags.push(`<span class="ed-meta-tag shared">👥 ${e.shares.length} compartido(s)</span>`);
  if (e.color)       tags.push(`<span class="ed-meta-tag" style="background:${e.color};color:#1a1100">🎨</span>`);
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

function renderChecklist() {
  const root = $('#ed-checklist-list');
  if (!root) return;
  root.innerHTML = '';
  const e = State.editing;
  if (!e) return;
  const items = e.checklist_items || [];
  for (const it of items) {
    const row = document.createElement('div');
    row.className = `ed-check-row ${it.done ? 'done' : ''}`;
    row.innerHTML = `
      <input type="checkbox" ${it.done ? 'checked' : ''}>
      <textarea rows="1">${escapeHtml(it.text || '')}</textarea>
      <button class="btn-icon" title="Eliminar">×</button>
    `;
    const chk = row.querySelector('input[type=checkbox]');
    const txt = row.querySelector('textarea');
    const del = row.querySelector('button');
    chk.addEventListener('change', () => { it.done = chk.checked; row.classList.toggle('done', chk.checked); scheduleSave(); });
    txt.addEventListener('input',  () => { it.text = txt.value; autoGrow(txt); scheduleSave(); });
    del.addEventListener('click',  () => { e.checklist_items = e.checklist_items.filter(x => x.id !== it.id); renderChecklist(); scheduleSave(); });
    root.appendChild(row);
    autoGrow(txt); // must be after DOM insertion so scrollHeight is accurate
  }
  // add row
  const add = document.createElement('div');
  add.className = 'ed-check-add';
  add.innerHTML = `<input type="text" placeholder="+ Nuevo ítem"><button class="btn-icon">+</button>`;
  const [addInp, addBtn] = add.querySelectorAll('input,button');
  const doAdd = () => {
    const v = addInp.value.trim();
    if (!v) return;
    e.checklist_items = (e.checklist_items || []).concat([{ id: crypto.randomUUID(), text: v, done: false, order: (e.checklist_items?.length || 0) }]);
    renderChecklist();
    scheduleSave();
    // Re-focus add input after DOM rebuild
    const newAddInp = root.querySelector('.ed-check-add input');
    if (newAddInp) newAddInp.focus();
  };
  addInp.addEventListener('keydown', ev => { if (ev.key === 'Enter') doAdd(); });
  addBtn.addEventListener('click', doAdd);
  root.appendChild(add);
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
      if (!confirm('¿Eliminar adjunto?')) return;
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
  $('#ed-status').textContent = 'Guardado';
  updateEditorMeta();
  renderGrid();
}

function closeEditor() {
  if (State.editing) commitEditor();
  $('#editor').hidden = true;
  State.editing = null;
}

function openNew() {
  const me = getUserEmail();
  const n = {
    id: crypto.randomUUID(),
    owner_email: me,
    title: '',
    body: '',
    type: 'text',
    checklist_items: [],
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
}

// ── PIN unlock prompt ────────────────────────────────────────────────────────
async function promptUnlock() {
  return new Promise(async (resolve) => {
    State.pinPending = resolve;
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
  if (State.pinPending) {
    State.pinPending(!!ok);
    State.pinPending = null;
  }
}

// ── action: pin / archive / lock / color / categories / share / reminder ────
function bindEditorActions() {
  $('#ed-pin').addEventListener('click', () => {
    State.editing.pinned = !State.editing.pinned;
    scheduleSave(); updateEditorMeta(); renderGrid();
  });
  $('#ed-lock').addEventListener('click', () => {
    State.editing.locked = !State.editing.locked;
    scheduleSave(); updateEditorMeta(); renderGrid();
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
      // convert back to text
      const txt = (e.checklist_items || []).map(it => `${it.done ? '[x]' : '[ ]'} ${it.text}`).join('\n');
      e.body = (e.body ? e.body + '\n' : '') + txt;
      e.type = 'text';
      e.checklist_items = [];
    } else {
      e.type = 'checklist';
      if (!e.checklist_items?.length && e.body) {
        e.checklist_items = e.body.split('\n').filter(l => l.trim()).map(l => ({
          id: crypto.randomUUID(),
          text: l.replace(/^\[\s?[xX]?\s?\]\s*/, ''),
          done: /^\[\s?[xX]\s?\]/.test(l),
          order: 0,
        }));
        e.body = '';
      }
    }
    $('#ed-body').hidden = e.type === 'checklist';
    $('#ed-checklist-list').hidden = e.type !== 'checklist';
    renderChecklist();
    scheduleSave();
  });
  $('#ed-delete').addEventListener('click', async () => {
    if (!confirm('¿Mover a la papelera?')) return;
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
      hidePopups();
      scheduleSave();
      updateEditorMeta();
      renderGrid();
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
      color: '#fbbf24',
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
  const r = anchor.getBoundingClientRect();
  p.style.top  = `${r.bottom + 6}px`;
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, r.left))}px`;
  p.hidden = false;
}
function hidePopups() {
  $$('.popup').forEach(p => p.hidden = true);
}

// ── settings drawer ──────────────────────────────────────────────────────────
function bindDrawer() {
  $('#btn-settings').addEventListener('click', () => $('#drawer').hidden = false);
  $$('#drawer [data-close-drawer]').forEach(el => el.addEventListener('click', () => $('#drawer').hidden = true));
  $$('#drawer .drawer-item[data-view]').forEach(b => b.addEventListener('click', (e) => {
    setView(e.currentTarget.dataset.view);
    $('#drawer').hidden = true;
  }));
  $('#drawer-cat-add').addEventListener('click', async () => {
    const inp = $('#drawer-cat-name');
    const name = inp.value.trim();
    if (!name) return;
    const cat = {
      id: crypto.randomUUID(),
      owner_email: getUserEmail(),
      name,
      color: '#fbbf24',
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
  $('#btn-new').addEventListener('click', openNew);

  $$('.cat-pill[data-cat]').forEach(p => p.addEventListener('click', () => setView(p.dataset.cat)));
  $('#btn-cat-new').addEventListener('click', () => {
    const name = prompt('Nombre de la categoría');
    if (!name) return;
    const cat = {
      id: crypto.randomUUID(),
      owner_email: getUserEmail(),
      name: name.trim(),
      color: '#fbbf24',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    State.categories.push(cat);
    saveCategoryLocal(cat);
    apiCreateCat({ id: cat.id, name: cat.name, color: cat.color }).catch(() => {});
    renderCategoriesStrip();
    renderDrawerCats();
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
    if (e.target.closest('#ed-color, #ed-categories, #ed-share, #ed-reminder')) return;
    hidePopups();
  });

  bindEditorActions();
  bindDrawer();
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
