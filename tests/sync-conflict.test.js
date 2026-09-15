// Que hace el cliente cuando el servidor rechaza un guardado por conflicto.
//
// El servidor ya no deja que el segundo dispositivo pise al primero (409), pero
// eso por si solo solo mueve el problema: si el cliente ignorara el rechazo, lo
// escrito en este dispositivo se perderia igual, solo que ahora en silencio del
// otro lado. Lo que se prueba aqui es la otra mitad: que se guarde una copia de
// rescate, que se adopte el estado del servidor y que la app se entere.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// localStorage minimo: el modulo lo usa para la copia de rescate.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, readyState: 'complete' };

// Respuestas que el "servidor" dara, en orden.
let respuestas = [];
let peticiones = [];
globalThis.fetch = async (url, opts) => {
  peticiones.push({ url, opts });
  const r = respuestas.shift();
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const sync = await import('../planner/sync.js');

// La sesion se guarda en localStorage, asi que requireSession resuelve sin pintar
// ninguna pantalla de login.
store.set('planner_jwt', 'token-de-test');
store.set('planner_email', 'ef@x.com');
await sync.initAuth();

const ESTADO = (extra = {}) => ({ goals: [], lastModified: 100, ...extra });

beforeEach(() => {
  respuestas = [];
  peticiones = [];
  store.delete('planner_v1_rescate');
});

test('al leer se guarda la revision, y al guardar se manda', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 7 } });
  await sync.pull();

  respuestas.push({ status: 200, body: { ok: true, rev: 8 } });
  await sync.push(ESTADO());

  assert.match(peticiones[1].url, /\?rev=7$/, 'el guardado declara desde que version parte');
});

test('tras guardar, la revision avanza sola', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 1 } });
  await sync.pull();
  respuestas.push({ status: 200, body: { ok: true, rev: 2 } });
  await sync.push(ESTADO());
  respuestas.push({ status: 200, body: { ok: true, rev: 3 } });
  await sync.push(ESTADO());

  assert.match(peticiones[2].url, /\?rev=2$/, 'sin volver a leer');
});

test('ante un conflicto se conserva lo escrito aqui antes de adoptar lo del servidor', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 1 } });
  await sync.pull();

  const mio = ESTADO({ lastModified: 500, desde: 'este-dispositivo' });
  const suyo = ESTADO({ lastModified: 600, desde: 'el-otro' });

  let adoptado = null;
  sync.onConflict(remote => { adoptado = remote; });
  respuestas.push({ status: 409, body: { error: 'conflicto', rev: 2, data: suyo } });

  await assert.rejects(() => sync.push(mio), /rechazado/);

  assert.deepEqual(adoptado, suyo, 'la app recibe el estado vigente para repintar');

  const rescate = JSON.parse(localStorage.getItem('planner_v1_rescate'));
  assert.deepEqual(rescate.state, mio, 'lo que se iba a guardar queda recuperable');
  assert.ok(rescate.at > 0, 'con la fecha, para saber de cuando es');
});

test('tras el conflicto se adopta la revision nueva: el siguiente guardado pasa', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 1 } });
  await sync.pull();

  sync.onConflict(() => {});
  respuestas.push({ status: 409, body: { error: 'conflicto', rev: 5, data: ESTADO() } });
  await assert.rejects(() => sync.push(ESTADO()));

  respuestas.push({ status: 200, body: { ok: true, rev: 6 } });
  await sync.push(ESTADO());
  assert.match(peticiones[2].url, /\?rev=5$/, 'no se queda bloqueado en la revision vieja');
});

test('sin handler registrado el conflicto no revienta nada', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 1 } });
  await sync.pull();
  sync.onConflict(null);
  respuestas.push({ status: 409, body: { error: 'conflicto', rev: 2, data: ESTADO() } });
  await assert.rejects(() => sync.push(ESTADO()), /rechazado/);
  assert.ok(localStorage.getItem('planner_v1_rescate'), 'la copia de rescate se guarda igual');
});

test('un fallo de red normal no se confunde con un conflicto', async () => {
  respuestas.push({ status: 200, body: { data: ESTADO(), rev: 3 } });
  await sync.pull();

  let llamado = false;
  sync.onConflict(() => { llamado = true; });
  respuestas.push({ status: 500, body: { error: 'boom' } });
  await assert.rejects(() => sync.push(ESTADO()));

  assert.equal(llamado, false, 'un 500 no es alguien editando en otro sitio');
  assert.equal(localStorage.getItem('planner_v1_rescate'), null);

  respuestas.push({ status: 200, body: { ok: true, rev: 4 } });
  await sync.push(ESTADO());
  assert.match(peticiones[2].url, /\?rev=3$/, 'la revision no se movio por el error');
});
