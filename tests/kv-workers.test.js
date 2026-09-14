import test from 'node:test';
import assert from 'node:assert/strict';
import planner from '../workers/planner-worker/src/index.js';
import nutrition from '../workers/nutrition-worker/src/index.js';
import body from '../workers/body-metrics-worker/src/index.js';

const TOKEN = 'Bearer 151322';

function mkKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}
const req = (method, url, body, token = TOKEN) =>
  new Request(url, { method, body, headers: token ? { Authorization: token } : {} });

const APPS = [
  { name: 'planner',  mod: planner,   bind: 'PLANNER_KV',      key: 'planner-state',
    good: { goals: [{ id: 'g1', title: 'Meta' }], lastModified: 100 },
    bad:  [['sin goals', { lastModified: 1 }], ['goals no array', { goals: 'x', lastModified: 1 }]] },
  { name: 'nutrition', mod: nutrition, bind: 'NUTRITION_KV',    key: 'nutrition-state',
    good: { activeProfile: 'ef', profiles: { ef: { name: 'Yo' } }, lastModified: 100 },
    bad:  [['sin profiles', { lastModified: 1 }], ['profiles vacio', { profiles: {}, lastModified: 1 }]] },
  { name: 'body',      mod: body,      bind: 'BODY_METRICS_KV', key: 'body-metrics-state',
    good: { bodyComp: [], exercises: [{ id: 'sq' }], sessions: [], lastModified: 100 },
    bad:  [['sin sessions', { bodyComp: [], exercises: [], lastModified: 1 }],
           ['sessions no array', { bodyComp: [], exercises: [], sessions: 3, lastModified: 1 }]] },
];

for (const app of APPS) {
  const URLB = 'https://w.dev/';

  test(`${app.name}: guarda un estado valido`, async () => {
    const kv = mkKv();
    const r = await app.mod.fetch(req('POST', URLB, JSON.stringify(app.good)), { [app.bind]: kv });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(kv.store.get(app.key)), app.good);
  });

  test(`${app.name}: un cuerpo vacio NO borra lo guardado`, async () => {
    const prev = JSON.stringify(app.good);
    const kv = mkKv({ [app.key]: prev });
    for (const payload of ['', '   ', 'null']) {
      const r = await app.mod.fetch(req('POST', URLB, payload), { [app.bind]: kv });
      assert.equal(r.status, 400, `payload ${JSON.stringify(payload)} deberia rechazarse`);
    }
    assert.equal(kv.store.get(app.key), prev, 'el estado previo sobrevive');
  });

  test(`${app.name}: JSON invalido y arrays se rechazan`, async () => {
    const prev = JSON.stringify(app.good);
    const kv = mkKv({ [app.key]: prev });
    for (const payload of ['{no json', '[1,2,3]', '"texto"', '42']) {
      const r = await app.mod.fetch(req('POST', URLB, payload), { [app.bind]: kv });
      assert.equal(r.status, 400, `payload ${payload} deberia rechazarse`);
    }
    assert.equal(kv.store.get(app.key), prev);
  });

  test(`${app.name}: estados con la forma equivocada se rechazan`, async () => {
    const prev = JSON.stringify(app.good);
    for (const [label, payload] of app.bad) {
      const kv = mkKv({ [app.key]: prev });
      const r = await app.mod.fetch(req('POST', URLB, JSON.stringify(payload)), { [app.bind]: kv });
      assert.equal(r.status, 400, label);
      assert.equal(kv.store.get(app.key), prev, label + ': no toco lo guardado');
    }
  });

  test(`${app.name}: sin token no se lee ni se escribe`, async () => {
    const kv = mkKv({ [app.key]: JSON.stringify(app.good) });
    assert.equal((await app.mod.fetch(req('GET', URLB, null, null), { [app.bind]: kv })).status, 401);
    assert.equal((await app.mod.fetch(req('POST', URLB, '{}', null), { [app.bind]: kv })).status, 401);
  });

  test(`${app.name}: el cron respalda y el respaldo se puede listar y restaurar`, async () => {
    const original = JSON.stringify(app.good);
    const kv = mkKv({ [app.key]: original });
    const waits = [];
    await app.mod.scheduled({}, { [app.bind]: kv }, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);

    const day = new Date().toISOString().slice(0, 10);
    const list = await (await app.mod.fetch(req('GET', URLB + '?backups'), { [app.bind]: kv })).json();
    assert.deepEqual(list.backups, [day]);

    // el usuario cambia el estado
    const nuevo = { ...app.good, lastModified: 999 };
    await app.mod.fetch(req('POST', URLB, JSON.stringify(nuevo)), { [app.bind]: kv });
    assert.equal(JSON.parse(kv.store.get(app.key)).lastModified, 999);

    // lee el respaldo sin tocar nada
    const peek = await (await app.mod.fetch(req('GET', URLB + '?backup=' + day), { [app.bind]: kv })).json();
    assert.equal(peek.data.lastModified, 100);
    assert.equal(JSON.parse(kv.store.get(app.key)).lastModified, 999, 'leer un respaldo no restaura');

    // restaura
    const rest = await app.mod.fetch(req('POST', URLB + '?restore=' + day), { [app.bind]: kv });
    assert.equal(rest.status, 200);
    assert.equal(kv.store.get(app.key), original);
  });

  test(`${app.name}: restaurar un dia inexistente no toca nada`, async () => {
    const prev = JSON.stringify(app.good);
    const kv = mkKv({ [app.key]: prev });
    const r = await app.mod.fetch(req('POST', URLB + '?restore=1999-01-01'), { [app.bind]: kv });
    assert.equal(r.status, 404);
    assert.equal(kv.store.get(app.key), prev);
  });

  test(`${app.name}: respaldar con KV vacio no crea basura`, async () => {
    const kv = mkKv();
    const waits = [];
    await app.mod.scheduled({}, { [app.bind]: kv }, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    assert.equal(kv.store.size, 0);
  });
}
