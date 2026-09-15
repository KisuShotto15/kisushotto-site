// notes/sync.js — pull/push with IndexedDB cache and offline queue.

import * as idb from './idb.js';
import { apiSyncPull, apiSyncPush, apiDeleteCat } from './api.js';

let pushTimer = null;
let pushing = false;

// Aviso a la app cuando un choque de ediciones se resolvio creando una copia.
let onNoteConflictCb = null;
export function onNoteConflict(cb) { onNoteConflictCb = cb; }

// Lo que cuenta como "la misma nota". Si dos dispositivos escribieron lo mismo no
// hay nada que salvar, y crear una copia seria justo el ruido que genero el
// intento anterior de detectar conflictos.
function sameContent(a, b) {
  const norm = n => JSON.stringify([
    n.title || '', n.body || '', n.type || 'text',
    n.checklist_items || [], n.color || null,
    !!n.pinned, !!n.archived, n.trashed_at || null, !!n.locked, n.reminder_at || null,
  ]);
  return norm(a) === norm(b);
}

// Que nota de rescate hay que crear, si es que hay alguna. Separado del guardado
// para poder probarlo: es la decision que, mal tomada, llena la app de copias.
export function conflictCopy(local, remote) {
  if (!local || !remote) return null;
  if (sameContent(local, remote)) return null;
  return {
    ...local,
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    title: (local.title || 'Nota') + ' — versión de este dispositivo',
    created_at: Date.now(),
    last_modified: Date.now(),
    base_lm: null,       // nota nueva: no tiene base contra la que chocar
    shares: [],
    attachments: [],     // los adjuntos siguen colgando de la original
  };
}

// El servidor rechazo el push porque alguien escribio en medio. Lo del servidor
// manda (lo adopta el bucle de result.notes de mas abajo); lo que se habia escrito
// aqui NO se tira: si difiere de verdad, queda como una nota nueva al lado.
async function resolveNoteConflict(id, serverNotes) {
  const local = await idb.getOne('notes', id);
  const remote = (serverNotes || []).find(x => x.id === id);
  const copia = conflictCopy(local, remote);
  if (!copia) return false;
  await idb.putAndEnqueue('notes', copia, 'note');
  return true;
}

function isOnline() { return typeof navigator !== 'undefined' ? navigator.onLine !== false : true; }

export async function pull() {
  if (!isOnline()) return { offline: true };
  let changed = false;
  const changedNoteIds = new Set();
  // The server caps each page (LIMIT). When `has_more` is set we page older
  // rows via the `before` upper bound (since stays fixed) and only advance the
  // cursor to server_time once the whole backlog is drained — otherwise the
  // older notes would be silently stranded.
  const since = (await idb.getMeta('lastSyncedAt')) || 0;
  let before = null;
  let serverTime = null;
  let stalled = false;
  let drained = false;
  let guard = 0;
  while (guard++ < 200) {
    const data = await apiSyncPull(since, before);
    const res = await applyPulled(data, changedNoteIds);
    if (res.changed) changed = true;
    if (data.server_time) serverTime = data.server_time;
    const notes = data.notes || [];
    if (data.has_more && notes.length) {
      // Preferir el cursor del server (min solo de las fuentes que llenaron su
      // pagina); el min local mezcla own+shared y puede saltarse filas.
      const oldest = Number.isFinite(data.next_before)
        ? data.next_before
        : Math.min(...notes.map(n => n.last_modified || 0));
      if (!isFinite(oldest) || (before != null && oldest >= before)) { stalled = true; break; }
      before = oldest;
      continue;
    }
    drained = true;
    break;
  }
  // Si el backlog no se termino de drenar (stall o guard agotado), NO avanzar
  // el cursor: avanzar dejaria las filas restantes varadas para siempre.
  if (serverTime != null && drained && !stalled) await idb.setMeta('lastSyncedAt', serverTime);
  return { ok: true, changed, changedNoteIds };
}

async function applyPulled(data, changedNoteIds) {
  let changed = false;
  // The outbox is authoritative: an entity with a pending local change must
  // NEVER be overwritten (or, for categories, wiped) by server data — client
  // and server last_modified come from different clocks and are not comparable.
  const queueItems = await idb.peekQueue();
  const pendingNotes = new Set(
    queueItems.filter(i => i.type === 'note' || i.type === 'note-del').map(i => i.id)
  );
  const pendingCats = new Set(
    queueItems.filter(i => i.type === 'category' || i.type === 'category-del').map(i => i.id)
  );
  for (const n of data.notes || []) {
    if (pendingNotes.has(n.id)) continue; // local has unsynced changes — keep them
    const local = await idb.getOne('notes', n.id);
    if (!local || (local.last_modified || 0) < (n.last_modified || 0)) {
      // Server schema has no sort_order column — preserve the local one so
      // pulls don't rebuild it from last_modified and reshuffle the grid.
      if (local && n.sort_order == null && local.sort_order != null) {
        n.sort_order = local.sort_order;
      }
      // base_lm = ultimo estado canonico del server visto por este cliente;
      // se manda en el push para que el server detecte ediciones concurrentes.
      n.base_lm = n.last_modified;
      // Atomico: si una edicion local se encolo despues del peekQueue de
      // arriba, la escritura se descarta en vez de pisarla.
      await idb.putIfNotQueued('notes', n);
      changed = true;
      changedNoteIds.add(n.id);
    }
  }
  // Categories: merge per-id (never clear+rebuild) so a category that was just
  // created/edited/deleted locally and hasn't been pushed yet survives a pull
  // that races with the debounced flush.
  const incomingCats = data.categories || [];
  const localCats = await idb.getAll('categories');
  const localMap = Object.fromEntries(localCats.map(c => [c.id, c]));
  const incomingIds = new Set();
  for (const c of incomingCats) {
    incomingIds.add(c.id);
    if (pendingCats.has(c.id)) continue; // local create/edit/delete still in flight
    const localC = localMap[c.id];
    if (!c.icon && localC?.icon) c.icon = localC.icon;
    if (!localC || localC.updated_at !== c.updated_at) {
      await idb.putIfNotQueued('categories', c);
      changed = true;
    }
  }
  for (const c of localCats) {
    if (!incomingIds.has(c.id) && !pendingCats.has(c.id)) {
      // Absent from the server and nothing pending locally — deleted elsewhere.
      // (delIfNotQueued: una categoria creada/editada durante este pull tiene
      // entrada en cola y no debe borrarse por ausencia.)
      await idb.delIfNotQueued('categories', c.id);
      changed = true;
    }
  }
  return { changed };
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

    const syncItems = items.filter(i => i.type === 'note' || i.type === 'category');
    const delItems  = items.filter(i => i.type === 'category-del');

    if (syncItems.length) {
      const noteIds = new Set();
      const catIds = new Set();
      for (const it of syncItems) {
        if (it.type === 'note')     noteIds.add(it.id);
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
      // Excepcion: un item que el server reporto como fallido (skipped por
      // error transitorio) se queda en cola para reintentar — antes se
      // descartaba y la edicion se perdia en silencio. 'forbidden' nunca va a
      // funcionar, asi que si se descarta.
      // 'conflict' sale de la cola como 'forbidden': reintentar no arregla nada,
      // porque el base_lm que se volveria a mandar sigue siendo el viejo. Se
      // resuelve aparte, justo debajo.
      const enConflicto = [];
      const confirmed = syncItems.filter(it => {
        const r = it.type === 'note' ? result.results?.notes?.[it.id] : result.results?.categories?.[it.id];
        if (r?.reason === 'conflict') { enConflicto.push(it.id); return true; }
        if (r?.skipped && r.reason !== 'forbidden') return false;
        if (r?.skipped) console.warn('push rechazado (sin permiso), se descarta', it.type, it.id);
        return true;
      });
      await idb.dequeueIfUnchanged(confirmed);

      let copias = 0;
      for (const id of enConflicto) {
        try { if (await resolveNoteConflict(id, result.notes)) copias++; }
        catch (e) { console.warn('no se pudo resolver el conflicto de', id, e); }
      }
      if (copias && onNoteConflictCb) onNoteConflictCb(copias);

      // Recompute pending after dequeue: entries still queued were edited again
      // mid-flight and must not be clobbered by the now-stale server canonical.
      const queueAfter = await idb.peekQueue();
      const stillPendingNotes = new Set(queueAfter.filter(i => i.type === 'note').map(i => i.id));
      const stillPendingCats  = new Set(
        queueAfter.filter(i => i.type === 'category' || i.type === 'category-del').map(i => i.id)
      );

      // Apply server-canonical state back into IDB, preserving local sort_order
      // (server schema does not persist this column).
      for (const n of result.notes || []) {
        if (stillPendingNotes.has(n.id)) {
          // Edicion nueva en vuelo: no pisar el contenido, pero SI adelantar
          // base_lm al lm que el server asigno a NUESTRO upsert (results, no
          // result.notes, que puede traer la version de otro dispositivo) —
          // asi el proximo flush no dispara una copia de conflicto contra
          // nuestra propia version intermedia, y un conflicto real se detecta.
          const rr = result.results?.notes?.[n.id];
          if (rr && !rr.skipped && rr.last_modified) {
            await idb.patchOne('notes', n.id, { base_lm: rr.last_modified });
          }
          continue;
        }
        const local = await idb.getOne('notes', n.id);
        if (local && n.sort_order == null && local.sort_order != null) {
          n.sort_order = local.sort_order;
        }
        n.base_lm = n.last_modified;
        await idb.putIfNotQueued('notes', n);
      }
      for (const c of result.categories || []) {
        if (stillPendingCats.has(c.id)) continue; // newer local edit/delete pending — keep it
        await idb.putIfNotQueued('categories', c);
      }
      if (result.has_more) {
        // Canonical state was truncated — leave the cursor where it was so the
        // next pull() pages the remaining older notes before advancing it.
      } else if (result.server_time) {
        await idb.setMeta('lastSyncedAt', result.server_time);
      }
    }

    // Category deletions go through the single-item endpoint (the batch sync
    // endpoint has no delete verb) with their own per-item retry: a transient
    // failure leaves the item queued; "not found" means it's already gone.
    for (const it of delItems) {
      try {
        await apiDeleteCat(it.id);
        await idb.dequeueIfUnchanged([it]);
      } catch (e) {
        if (String(e?.message || '').startsWith('API 404')) {
          await idb.dequeueIfUnchanged([it]);
        }
        // otherwise leave queued — retried on next flush
      }
    }
  } catch (e) {
    console.warn('flushQueue failed — will retry on next flush', e);
    // Items remain in queue; next flushQueue call will retry them
  } finally {
    pushing = false;
  }
}

export async function saveNoteLocal(note) {
  try {
    await idb.putAndEnqueue('notes', note, 'note');
  } catch (e) {
    console.warn('IDB write failed (Brave Shields?)', e);
  }
  pushQueueDebounced();
}

export async function saveCategoryLocal(cat) {
  try {
    await idb.putAndEnqueue('categories', cat, 'category');
  } catch (e) {
    console.warn('IDB write failed (Brave Shields?)', e);
  }
  pushQueueDebounced();
}

export async function deleteCategoryLocal(id) {
  await idb.del('categories', id);
  await idb.enqueue({ type: 'category-del', id });
  pushQueueDebounced();
}

export function onConnectionChange(cb) {
  window.addEventListener('online', () => { cb(true); flushQueue(); });
  window.addEventListener('offline', () => cb(false));
}
