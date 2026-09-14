// La puerta de entrada de Notas y Habitos.
//
// Antes: Notas aceptaba un token publicado en el bundle y ademas entregaba una
// sesion valida para CUALQUIER email via /auth/passkey/register, sin verificar
// ninguna firma WebAuthn. Habitos resolvia la identidad leyendo la cabecera
// X-User-Email, que escribe el propio cliente. Estos tests fijan que ninguna de
// las dos cosas vuelva.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'secreto-de-test';
const { signJWT } = await import('../api/_lib/crypto.js');

const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      if (!cacheStore.has(req.url)) return undefined;
      return new Response(cacheStore.get(req.url));
    },
    async put(req, res) { cacheStore.set(req.url, await res.text()); },
  },
};
let revokeStatus = 200;
globalThis.fetch = async () => new Response('{}', { status: revokeStatus });

const notes = (await import('../workers/notes-worker/src/index.js')).default;
const habits = (await import('../workers/habits-worker/src/index.js')).default;

const YO = 'ef@x.com';
const jwt = email => signJWT({ uid: 1, email });

// D1 minimo: basta para que migrate() y las consultas no exploten. Lo que se
// prueba aqui es quien entra, no que se guarde bien.
const DB = {
  prepare: () => ({
    bind() { return this; },
    async run() { return { meta: { changes: 0 } }; },
    async first() { return null; },
    async all() { return { results: [] }; },
  }),
  async batch() { return []; },
};
const env = { JWT_SECRET: process.env.JWT_SECRET, ALLOWED_EMAILS: YO, DB, PUSH_KV: { async get() { return null; }, async put() {} } };

const req = (method, path, headers = {}, body) =>
  new Request('https://w.dev' + path, { method, headers, body });

// ── Notas ───────────────────────────────────────────────────────────────────

test('notas: el token compartido del bundle ya no abre nada', async () => {
  for (const h of [{}, { Authorization: 'Bearer 151322' }, { 'X-Session-Token': 'lo-que-sea' }]) {
    const r = await notes.fetch(req('GET', '/sync', h), env);
    assert.equal(r.status, 401);
  }
});

test('notas: registrar una passkey ya no entrega una sesion para cualquier email', async () => {
  // Esta era la peticion que bastaba para entrar como otra persona.
  const r = await notes.fetch(req('POST', '/auth/passkey/register',
    { Authorization: 'Bearer 151322', 'Content-Type': 'application/json' },
    JSON.stringify({ email: 'victima@x.com', credentialId: 'inventado' })), env);
  assert.equal(r.status, 401);
  const cuerpo = await r.text();
  assert.doesNotMatch(cuerpo, /session/i, 'no puede devolver ninguna sesion');
});

test('notas: los endpoints que emitian sesion ya no existen ni con sesion valida', async () => {
  const h = { Authorization: 'Bearer ' + jwt(YO), 'Content-Type': 'application/json' };
  for (const path of ['/auth/passkey/register', '/auth/passkey/authenticate', '/auth/passkey/check']) {
    const r = await notes.fetch(req('POST', path, h, JSON.stringify({ email: 'x@x.com', credentialId: 'c' })), env);
    assert.equal(r.status, 404, path + ' deberia haber desaparecido');
  }
});

test('notas: un email fuera de la lista no entra', async () => {
  const r = await notes.fetch(req('GET', '/me', { Authorization: 'Bearer ' + jwt('intruso@x.com') }), env);
  assert.equal(r.status, 401);
});

test('notas: un JWT valido y autorizado si entra', async () => {
  const r = await notes.fetch(req('GET', '/me', { Authorization: 'Bearer ' + jwt(YO) }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email, YO);
});

test('notas: una sesion revocada deja de valer', async () => {
  revokeStatus = 401;
  cacheStore.clear();
  try {
    const r = await notes.fetch(req('GET', '/me', { Authorization: 'Bearer ' + jwt(YO) }), env);
    assert.equal(r.status, 401);
  } finally {
    revokeStatus = 200;
    cacheStore.clear();
  }
});

// ── Habitos ─────────────────────────────────────────────────────────────────

test('habitos: la cabecera X-User-Email ya no identifica a nadie', async () => {
  // Esto era literalmente el "login" de la app.
  const r = await habits.fetch(req('GET', '/habits',
    { Authorization: 'Bearer 151322', 'X-User-Email': YO }), env);
  assert.equal(r.status, 401);
});

test('habitos: un JWT valido no se puede suplantar con la cabecera', async () => {
  const r = await habits.fetch(req('GET', '/habits', {
    Authorization: 'Bearer ' + jwt(YO),
    'X-User-Email': 'victima@x.com',
  }), env);
  assert.equal(r.status, 200, 'entra como el del JWT, ignorando la cabecera');
});

test('habitos: un email fuera de la lista no entra', async () => {
  const r = await habits.fetch(req('GET', '/habits', { Authorization: 'Bearer ' + jwt('intruso@x.com') }), env);
  assert.equal(r.status, 401);
});

test('habitos: el preflight no necesita credencial y no abre el origen a todos', async () => {
  const r = await habits.fetch(req('OPTIONS', '/habits'), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://habits.kisushotto.com');
});
