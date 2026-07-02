// notes/idb.js — minimal IndexedDB wrapper for offline cache + mutation queue.

const DB_NAME = 'notesdb';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('lastModified', 'last_modified');
        s.createIndex('archived', 'archived');
        s.createIndex('trashed', 'trashed_at');
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('attachments')) {
        const s = db.createObjectStore('attachments', { keyPath: 'id' });
        s.createIndex('noteId', 'note_id');
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(storeNames, mode = 'readonly') {
  return openDB().then(db => db.transaction(storeNames, mode));
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Generic CRUD
export async function put(store, value) {
  const t = await tx(store, 'readwrite');
  return reqAsPromise(t.objectStore(store).put(value));
}
export async function getAll(store) {
  const t = await tx(store);
  return reqAsPromise(t.objectStore(store).getAll());
}
export async function getOne(store, key) {
  const t = await tx(store);
  return reqAsPromise(t.objectStore(store).get(key));
}
export async function del(store, key) {
  const t = await tx(store, 'readwrite');
  return reqAsPromise(t.objectStore(store).delete(key));
}
export async function clear(store) {
  const t = await tx(store, 'readwrite');
  return reqAsPromise(t.objectStore(store).clear());
}

// Meta
export async function getMeta(key) {
  const v = await getOne('meta', key);
  return v?.value;
}
export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// Escribe la entidad y su entrada de cola en UNA transaccion: un pull
// concurrente nunca puede ver la entidad nueva sin su marca de pendiente
// (la ventana put→enqueue permitia que datos del server pisaran el guardado).
export async function putAndEnqueue(store, value, type) {
  const t = await tx([store, 'queue'], 'readwrite');
  t.objectStore(store).put(value);
  t.objectStore('queue').put({ type, id: value.id, queued_at: Date.now() });
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

// Aplica datos del server solo si la entidad no tiene un cambio local en cola.
// Verificacion y escritura comparten transaccion: elimina la carrera
// peek→put en la que una edicion hecha durante el pull podia perderse.
export async function putIfNotQueued(store, value) {
  const t = await tx([store, 'queue'], 'readwrite');
  const q = t.objectStore('queue').get(value.id);
  q.onsuccess = () => { if (!q.result) t.objectStore(store).put(value); };
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

export async function delIfNotQueued(store, key) {
  const t = await tx([store, 'queue'], 'readwrite');
  const q = t.objectStore('queue').get(key);
  q.onsuccess = () => { if (!q.result) t.objectStore(store).delete(key); };
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

// Parchea campos puntuales sin reescribir el objeto completo (get+put en una
// transaccion, no pisa una edicion concurrente de otros campos).
export async function patchOne(store, key, patch) {
  const t = await tx(store, 'readwrite');
  const s = t.objectStore(store);
  const g = s.get(key);
  g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

// Queue
export async function enqueue(item) {
  return put('queue', { ...item, queued_at: Date.now() });
}
export async function peekQueue() {
  return getAll('queue');
}
export async function dequeueIds(ids) {
  if (!ids.length) return;
  const t = await tx('queue', 'readwrite');
  const store = t.objectStore('queue');
  ids.forEach(id => store.delete(id));
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}
// Delete only the queue records that have not changed since they were peeked.
// If an item was re-enqueued during an in-flight push its queued_at differs, so
// we keep it and let the next flush push the newer edit.
export async function dequeueIfUnchanged(items) {
  if (!items.length) return;
  const t = await tx('queue', 'readwrite');
  const store = t.objectStore('queue');
  for (const it of items) {
    const getReq = store.get(it.id);
    getReq.onsuccess = () => {
      const cur = getReq.result;
      if (cur && cur.queued_at === it.queued_at) store.delete(it.id);
    };
  }
  return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function queueSize() {
  const items = await getAll('queue');
  return items.length;
}
