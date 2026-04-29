// notes/sync.js — pull/push with IndexedDB cache and offline queue.

import * as idb from './idb.js';
import { apiSyncPull, apiSyncPush } from './api.js';

let pushTimer = null;
let pushing = false;

function isOnline() { return typeof navigator !== 'undefined' ? navigator.onLine !== false : true; }

export async function pull() {
  if (!isOnline()) return { offline: true };
  const since = (await idb.getMeta('lastSyncedAt')) || 0;
  const data = await apiSyncPull(since);
  for (const n of data.notes || []) {
    const local = await idb.getOne('notes', n.id);
    if (!local || local.last_modified <= n.last_modified) {
      await idb.put('notes', n);
    }
  }
  if (since === 0) {
    // Full sync: replace all categories to remove orphans from stale imports
    await idb.clear('categories');
  }
  for (const c of data.categories || []) {
    await idb.put('categories', c);
  }
  if (data.server_time) await idb.setMeta('lastSyncedAt', data.server_time);
  return { ok: true };
}

export async function pushQueueDebounced() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushQueue, 800);
}

export async function flushQueue() {
  if (pushing) return;
  if (!isOnline()) return;
  pushing = true;
  try {
    const items = await idb.dequeueAll();
    if (!items.length) return;

    // Re-read latest local copies for upsert
    const noteIds = new Set();
    const catIds = new Set();
    for (const it of items) {
      if (it.type === 'note')     noteIds.add(it.id);
      if (it.type === 'note-del') noteIds.add(it.id);
      if (it.type === 'category') catIds.add(it.id);
    }
    const notes = [];
    for (const id of noteIds) {
      const n = await idb.getOne('notes', id);
      if (n) notes.push(n);
    }
    const categories = [];
    for (const id of catIds) {
      const c = await idb.getOne('categories', id);
      if (c) categories.push(c);
    }

    const since = (await idb.getMeta('lastSyncedAt')) || 0;
    const result = await apiSyncPush({ notes, categories, since });

    // Apply server-canonical state back into IDB
    for (const n of result.notes || []) {
      await idb.put('notes', n);
    }
    for (const c of result.categories || []) {
      await idb.put('categories', c);
    }
    if (result.server_time) await idb.setMeta('lastSyncedAt', result.server_time);
  } catch (e) {
    console.warn('flushQueue failed', e);
  } finally {
    pushing = false;
  }
}

export async function saveNoteLocal(note) {
  await idb.put('notes', note);
  await idb.enqueue({ type: 'note', id: note.id });
  pushQueueDebounced();
}

export async function saveCategoryLocal(cat) {
  await idb.put('categories', cat);
  await idb.enqueue({ type: 'category', id: cat.id });
  pushQueueDebounced();
}

export async function deleteCategoryLocal(id) {
  await idb.del('categories', id);
  // best-effort: caller must also call apiDeleteCat
}

export function onConnectionChange(cb) {
  window.addEventListener('online', () => { cb(true); flushQueue(); });
  window.addEventListener('offline', () => cb(false));
}
