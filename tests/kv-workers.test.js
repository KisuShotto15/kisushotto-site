// Los tres workers de KV: identidad por JWT del sitio, estado por usuario,
// validacion antes de escribir y respaldo diario.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'secreto-de-test';
const { signJWT } = await import('../api/_lib/crypto.js');

// El modulo de identidad usa la Cache API de Cloudflare, que no existe en Node.
// Cache vacia = siempre consulta a Vercel, que aqui tambien esta simulado.
// match() devuelve una Response NUEVA en cada llamada, igual que la real: el
// cuerpo de una Response solo se puede leer una vez.
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
// Por defecto, /api/auth/me dice que la sesion sigue viva.
let revokeStatus = 200;
globalThis.fetch = async () => new Response('{}', { status: revokeStatus });

const planner = (await import('../workers/planner-worker/src/index.js')).default;
const nutrition = (await import('../workers/nutrition-worker/src/index.js')).default;
const body = (await import('../workers/body-metrics-worker/src/index.js')).default;

const YO = 'ef@x.com';
const OTRO = 'otro@x.com';
const ENV_BASE = {
  JWT_SECRET: process.env.JWT_SECRET,
  ALLOWED_EMAILS: `${YO}, ${OTRO}`,
  OWNER_EMAIL: YO,
};
const jwt = email => signJWT({ uid: 1, email });

function mkKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

const req = (method, url, bodyStr, token) =>
  new Request(url, { method, body: bodyStr, headers: token ? { Authorization: 'Bearer ' + token } : {} });

const APPS = [
  {
    name: 'planner', mod: planner, bind: 'PLANNER_KV', key: 'planner-state',
    good: { goals: [{ id: 'g1', title: 'Meta' }], lastModified: 100 },
    bad: [['sin goals', { lastModified: 1 }], ['goals no array', { goals: 'x', lastModified: 1 }]],
  },
  {
    name: 'nutrition', mod: nutrition, bind: 'NUTRITION_KV', key: 'nutrition-state',
    good: { activeProfile: 'ef', profiles: { ef: { name: 'Yo' } }, lastModified: 100 },
    bad: [['sin profiles', { lastModified: 1 }], ['profiles vacio', { profiles: {}, lastModified: 1 }]],
  },
  {
    name: 'body', mod: body, bind: 'BODY_METRICS_KV', key: 'body-metrics-state',
    good: { bodyComp: [], exercises: [{ id: 'sq' }], sessions: [], lastModified: 100 },
    bad: [['sin sessions', { bodyComp: [], exercises: [], lastModified: 1 }],
          ['sessions no array', { bodyComp: [], exercises: [], sessions: 3, lastModified: 1 }]],
  },
];

const URLB = 'https://w.dev/';

for (const app of APPS) {
  const mine = app.key + ':' + YO;
  const theirs = app.key + ':' + OTRO;
  const call = (method, url, bodyStr, token, env = {}) =>
    app.mod.fetch(req(method, url, bodyStr, token), { ...ENV_BASE, ...env });

  test(`${app.name}: guarda el estado bajo la clave del usuario`, async () => {
    const kv = mkKv();
    const r = await call('POST', URLB, JSON.stringify(app.good), jwt(YO), { [app.bind]: kv });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(kv.store.get(mine)), app.good);
  });

  test(`${app.name}: un usuario NO ve ni pisa los datos de otro`, async () => {
    const kv = mkKv({ [mine]: JSON.stringify(app.good) });
    const leido = await (await call('GET', URLB, null, jwt(OTRO), { [app.bind]: kv })).json();
    assert.equal(leido.data, null, 'el otro usuario arranca vacio');

    const suyo = { ...app.good, lastModified: 777 };
    await call('POST', URLB, JSON.stringify(suyo), jwt(OTRO), { [app.bind]: kv });
    assert.equal(JSON.parse(kv.store.get(mine)).lastModified, 100, 'mis datos intactos');
    assert.equal(JSON.parse(kv.store.get(theirs)).lastModified, 777);
  });

  test(`${app.name}: sin token, con token falso o con firma alterada -> 401`, async () => {
    const kv = mkKv({ [mine]: JSON.stringify(app.good) });
    const t = jwt(YO);
    const casos = [undefined, '151322', t.slice(0, -3) + 'aaa', signJWT({ uid: 1, email: YO }, -10)];
    for (const tok of casos) {
      assert.equal((await call('GET', URLB, null, tok, { [app.bind]: kv })).status, 401);
      assert.equal((await call('POST', URLB, '{}', tok, { [app.bind]: kv })).status, 401);
    }
    assert.equal(kv.store.get(mine), JSON.stringify(app.good));
  });

  test(`${app.name}: un email fuera de la lista no entra`, async () => {
    const kv = mkKv();
    const r = await call('GET', URLB, null, jwt('intruso@x.com'), { [app.bind]: kv });
    assert.equal(r.status, 401);
  });

  test(`${app.name}: con la lista vacia no pasa nadie`, async () => {
    const kv = mkKv();
    const r = await app.mod.fetch(req('GET', URLB, null, jwt(YO)),
      { ...ENV_BASE, ALLOWED_EMAILS: '', [app.bind]: kv });
    assert.equal(r.status, 401);
  });

  test(`${app.name}: una sesion revocada deja de valer`, async () => {
    const kv = mkKv();
    revokeStatus = 401;
    cacheStore.clear();
    try {
      const r = await call('GET', URLB, null, jwt(YO), { [app.bind]: kv });
      assert.equal(r.status, 401);
    } finally {
      revokeStatus = 200;
      cacheStore.clear();
    }
  });

  test(`${app.name}: un cuerpo vacio o invalido NO borra lo guardado`, async () => {
    const prev = JSON.stringify(app.good);
    const kv = mkKv({ [mine]: prev });
    for (const payload of ['', '   ', 'null', '{no json', '[1,2,3]', '"texto"', '42']) {
      const r = await call('POST', URLB, payload, jwt(YO), { [app.bind]: kv });
      assert.equal(r.status, 400, `payload ${JSON.stringify(payload)} deberia rechazarse`);
    }
    assert.equal(kv.store.get(mine), prev, 'el estado previo sobrevive');
  });

  test(`${app.name}: estados con la forma equivocada se rechazan`, async () => {
    const prev = JSON.stringify(app.good);
    for (const [label, payload] of app.bad) {
      const kv = mkKv({ [mine]: prev });
      const r = await call('POST', URLB, JSON.stringify(payload), jwt(YO), { [app.bind]: kv });
      assert.equal(r.status, 400, label);
      assert.equal(kv.store.get(mine), prev, label + ': no toco lo guardado');
    }
  });

  test(`${app.name}: los datos de la clave global vieja pasan al dueño, y solo a el`, async () => {
    const legacy = JSON.stringify({ ...app.good, lastModified: 42 });

    const kvOtro = mkKv({ [app.key]: legacy });
    const ajeno = await (await call('GET', URLB, null, jwt(OTRO), { [app.bind]: kvOtro })).json();
    assert.equal(ajeno.data, null, 'los datos viejos no son de cualquiera');

    const kv = mkKv({ [app.key]: legacy });
    const mio = await (await call('GET', URLB, null, jwt(YO), { [app.bind]: kv })).json();
    assert.equal(mio.data.lastModified, 42, 'el dueño los adopta');
    assert.equal(kv.store.get(mine), legacy, 'quedan copiados a su clave');
    assert.equal(kv.store.get(app.key), legacy, 'y la global se conserva por si acaso');
  });

  test(`${app.name}: el cron respalda a cada usuario y cada quien ve solo los suyos`, async () => {
    const kv = mkKv();
    await call('POST', URLB, JSON.stringify(app.good), jwt(YO), { [app.bind]: kv });
    await call('POST', URLB, JSON.stringify({ ...app.good, lastModified: 555 }), jwt(OTRO), { [app.bind]: kv });

    const waits = [];
    await app.mod.scheduled({}, { ...ENV_BASE, [app.bind]: kv }, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);

    const day = new Date().toISOString().slice(0, 10);
    const mios = await (await call('GET', URLB + '?backups', null, jwt(YO), { [app.bind]: kv })).json();
    assert.deepEqual(mios.backups, [day]);

    const peek = await (await call('GET', `${URLB}?backup=${day}`, null, jwt(YO), { [app.bind]: kv })).json();
    assert.equal(peek.data.lastModified, 100, 'es mi respaldo, no el del otro');
  });

  test(`${app.name}: restaurar devuelve el estado del dia y guarda antes el vigente`, async () => {
    const original = JSON.stringify(app.good);
    const kv = mkKv();
    await call('POST', URLB, original, jwt(YO), { [app.bind]: kv });
    const waits = [];
    await app.mod.scheduled({}, { ...ENV_BASE, [app.bind]: kv }, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);

    await call('POST', URLB, JSON.stringify({ ...app.good, lastModified: 999 }), jwt(YO), { [app.bind]: kv });
    assert.equal(JSON.parse(kv.store.get(mine)).lastModified, 999);

    const day = new Date().toISOString().slice(0, 10);
    const r = await call('POST', `${URLB}?restore=${day}`, null, jwt(YO), { [app.bind]: kv });
    assert.equal(r.status, 200);
    assert.equal(kv.store.get(mine), original);
  });

  test(`${app.name}: restaurar un dia inexistente no toca nada`, async () => {
    const prev = JSON.stringify(app.good);
    const kv = mkKv({ [mine]: prev });
    const r = await call('POST', URLB + '?restore=1999-01-01', null, jwt(YO), { [app.bind]: kv });
    assert.equal(r.status, 404);
    assert.equal(kv.store.get(mine), prev);
  });

  test(`${app.name}: respaldar sin usuarios conocidos no crea basura`, async () => {
    const kv = mkKv();
    const waits = [];
    await app.mod.scheduled({}, { ...ENV_BASE, [app.bind]: kv }, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    assert.equal(kv.store.size, 0);
  });
}
