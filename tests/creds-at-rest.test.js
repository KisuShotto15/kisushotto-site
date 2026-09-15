// Que las credenciales no vuelvan a quedar en claro, y que el proxy no quede
// abierto cuando falta su secreto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEncrypted, decryptSecret } from '../workers/_shared/secret-box.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
globalThis.fetch = async () => new Response('{}', { status: 200 });

const tj = (await import('../workers/trade-journal-worker/src/index.js')).default;
const proxy = (await import('../workers/p2p-proxy/src/index.js')).default;

// ── Claves de Bybit: se guardan cifradas ────────────────────────────────────

// D1 minimo que recuerda lo que se le bindea en el INSERT de sync_configs.
function mkDB() {
  const saved = {};
  return {
    saved,
    prepare(sql) {
      return {
        bind(...args) {
          if (/INSERT INTO sync_configs/.test(sql)) {
            saved.apiKey = args[0];
            saved.apiSecret = args[1];
          }
          return this;
        },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
    async batch() { return []; },
  };
}

const CRED_ENC_KEY = 'a'.repeat(64);
const YO = 'ef@x.com';
const env = (extra = {}) => ({
  JWT_SECRET: process.env.JWT_SECRET, ALLOWED_EMAILS: YO, CRED_ENC_KEY, ...extra,
});
const post = (path, body, e) => tj.fetch(new Request('https://w.dev' + path, {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + signJWT({ uid: 1, email: YO }), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), e, { waitUntil() {} });

test('guardar la config de Bybit deja las claves cifradas, nunca en claro', async () => {
  const DB = mkDB();
  const r = await post('/sync/config', { apiKey: 'MI_API_KEY_REAL', apiSecret: 'MI_SECRETO_REAL' }, env({ DB }));
  assert.equal(r.status, 200);

  assert.ok(isEncrypted(DB.saved.apiKey), 'la api key va cifrada');
  assert.ok(isEncrypted(DB.saved.apiSecret), 'el secreto va cifrado');
  assert.ok(!DB.saved.apiKey.includes('MI_API_KEY_REAL'));
  assert.ok(!DB.saved.apiSecret.includes('MI_SECRETO_REAL'));

  const e = { CRED_ENC_KEY };
  assert.equal(await decryptSecret(e, DB.saved.apiKey), 'MI_API_KEY_REAL');
  assert.equal(await decryptSecret(e, DB.saved.apiSecret), 'MI_SECRETO_REAL');
});

test('sin clave de cifrado NO se guarda nada: mejor fallar que dejarlas en claro', async () => {
  const DB = mkDB();
  const r = await post('/sync/config', { apiKey: 'K', apiSecret: 'S' }, { ...env({ DB }), CRED_ENC_KEY: '' });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /cifrado/i);
  assert.equal(DB.saved.apiKey, undefined, 'no llego a tocar la base');
});

test('las credenciales se leen en un solo sitio', () => {
  // Cada lectura suelta de cfg.api_key es una que puede olvidarse de descifrar.
  const src = fs.readFileSync(path.join(ROOT, 'workers', 'trade-journal-worker', 'src', 'index.js'), 'utf8');
  const dentro = src.slice(src.indexOf('async function bybitCreds'), src.indexOf('function session('));
  const total = (src.match(/cfg\.api_(key|secret)/g) || []).length;
  const enLector = (dentro.match(/cfg\.api_(key|secret)/g) || []).length;
  assert.equal(total, enLector, 'hay lecturas de api_key/api_secret fuera de bybitCreds');
});

// ── Proxy P2P: sin secreto, cerrado ─────────────────────────────────────────

const proxyReq = (secret) => new Request('https://p.dev/', {
  method: 'POST',
  headers: secret ? { 'X-Api-Secret': secret, 'Content-Type': 'application/json' } : {},
  body: '{}',
});

test('sin API_SECRET configurado el proxy rechaza todo', async () => {
  // Antes la condicion era `if (env.API_SECRET && ...)`: al faltar la variable el
  // worker quedaba abierto a internet como proxy hacia Binance.
  for (const e of [{}, { API_SECRET: '' }]) {
    const r = await proxy.fetch(proxyReq('lo-que-sea'), e);
    assert.equal(r.status, 401);
  }
});

test('con secreto equivocado o ausente tambien rechaza', async () => {
  const e = { API_SECRET: 'el-bueno' };
  assert.equal((await proxy.fetch(proxyReq('el-malo'), e)).status, 401);
  assert.equal((await proxy.fetch(proxyReq(null), e)).status, 401);
});

test('el secreto viejo ya no esta en el repositorio', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'workers', 'p2p-proxy', 'wrangler.toml'), 'utf8');
  assert.ok(!/API_SECRET\s*=/.test(toml), 'API_SECRET no puede volver a [vars]');
  assert.ok(!toml.includes('ptk-2025'), 'el valor quemado no puede seguir aqui');
});

test('ningun wrangler.toml declara un secreto en texto plano', () => {
  const prohibidas = /^\s*(TOKEN|API_SECRET|JWT_SECRET|CRED_ENC_KEY|SESSION_SECRET|VAPID_PRIVATE\w*)\s*=/m;
  const malos = [];
  for (const d of fs.readdirSync(path.join(ROOT, 'workers'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(ROOT, 'workers', d.name, 'wrangler.toml');
    if (!fs.existsSync(f)) continue;
    // Solo lo que esta fuera de comentarios cuenta.
    const vivo = fs.readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    if (prohibidas.test(vivo)) malos.push(d.name);
  }
  assert.deepEqual(malos, []);
});
