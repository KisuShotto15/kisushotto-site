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
  let changed = false;
  const changedNoteIds = new Set();
  // The outbox is authoritative: a note with a pending local change must NEVER
  // be overwritten by server data, regardless of timestamps (client and server
  // last_modified come from different clocks and are not comparable).
  const pending = new Set(
    (await idb.peekQueue())
      .filter(i => i.type === 'note' || i.type === 'note-del')
      .map(i => i.id)
  );
  for (const n of data.notes || []) {
    if (pending.has(n.id)) continue; // local has unsynced changes — keep them
    const local = await idb.getOne('notes', n.id);
    if (!local || (local.last_modified || 0) < (n.last_modified || 0)) {
      // Server schema has no sort_order column — preserve the local one so
      // pulls don't rebuild it from last_modified and reshuffle the grid.
      if (local && n.sort_order == null && local.sort_order != null) {
        n.sort_order = local.sort_order;
      }
      await idb.put('notes', n);
      changed = true;
      changedNoteIds.add(n.id);
    }
  }
  const incomingCats = data.categories || [];
  const localCats = await idb.getAll('categories');
  const catsChanged = incomingCats.length !== localCats.length ||
    incomingCats.some((c, i) => !localCats[i] || localCats[i].updated_at !== c.updated_at);
  if (catsChanged) {
    const localMap = Object.fromEntries(localCats.map(c => [c.id, c]));
    await idb.clear('categories');
    for (const c of incomingCats) {
      if (!c.icon && localMap[c.id]?.icon) c.icon = localMap[c.id].icon;
      await idb.put('categories', c);
    }
    changed = true;
  }
  if (data.server_time) await idb.setMeta('lastSyncedAt', data.server_time);
  return { ok: true, changed, changedNoteIds };
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
    const items = await idb.peekQueue(); // read without removing — safe on failure
    if (!items.length) return;

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

    // Push succeeded — remove exactly the items we sent, but only if they have
    // not been re-queued since (a fresh edit during the in-flight push updates
    // queued_at; keep those so the new edit is pushed on the next flush).
    await idb.dequeueIfUnchanged(items);

    // Recompute pending after dequeue: notes still queued were edited again
    // mid-flight and must not be clobbered by the now-stale server canonical.
    const stillPending = new Set(
      (await idb.peekQueue())
        .filter(i => i.type === 'note' || i.type === 'note-del')
        .map(i => i.id)
    );

    // Apply server-canonical state back into IDB, preserving local sort_order
    // (server schema does not persist this column).
    for (const n of result.notes || []) {
      if (stillPending.has(n.id)) continue; // newer local edit pending — keep it
      const local = await idb.getOne('notes', n.id);
      if (local && n.sort_order == null && local.sort_order != null) {
        n.sort_order = local.sort_order;
      }
      await idb.put('notes', n);
    }
    for (const c of result.categories || []) {
      await idb.put('categories', c);
    }
    if (result.server_time) await idb.setMeta('lastSyncedAt', result.server_time);
  } catch (e) {
    console.warn('flushQueue failed — will retry on next flush', e);
    // Items remain in queue; next flushQueue call will retry them
  } finally {
    pushing = false;
  }
}

export async function saveNoteLocal(note) {
  try {
    await idb.put('notes', note);
    await idb.enqueue({ type: 'note', id: note.id });
  } catch (e) {
    console.warn('IDB write failed (Brave Shields?)', e);
  }
  pushQueueDebounced();
}

export async function saveCategoryLocal(cat) {
  try {
    await idb.put('categories', cat);
    await idb.enqueue({ type: 'category', id: cat.id });
  } catch (e) {
    console.warn('IDB write failed (Brave Shields?)', e);
  }
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
