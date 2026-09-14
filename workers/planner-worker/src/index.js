// planner-worker — estado del Planner en una clave de KV.
//
// Dos protecciones sobre el diseño original, que era "escribe en KV lo que llegue":
//
//  1. Validacion antes de escribir. Un POST vacio o con un cuerpo malformado
//     sobrescribia el estado entero, y no habia vuelta atras: una sola clave, sin
//     versiones. Ahora un cuerpo que no parsee, que no sea un objeto o al que le
//     falten las claves de la app se rechaza con 400 y NO toca lo guardado.
//  2. Respaldo diario (cron 04:00 UTC) con expiracion automatica a 7 dias. Un
//     borrado accidental deja de ser definitivo.

// La identidad sale del JWT del sitio, nunca de un token compartido ni de una
// cabecera. El estado vive en una clave POR USUARIO: antes era una sola clave
// global, asi que cualquiera con el token leia y sobrescribia los datos de todos.
import { authEmail } from '../../_shared/site-auth.js';

const KV_KEY = 'planner-state';
const BAK_PREFIX = 'planner-state-bak-';
const BAK_DAYS = 7;
// Tope de tamano: el estado real son decenas de KB. Un cuerpo enorme solo puede
// ser un error o un abuso. Se mide en caracteres, no en bytes: sobra para el fin.
const MAX_CHARS = 2 * 1024 * 1024;
// Claves que el cliente siempre manda (ver `let S = ...` en planner/index.html).
// Si faltan, lo que llego no es el estado del Planner.
const REQUIRED = ['goals', 'lastModified'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Devuelve el motivo del rechazo, o null si el cuerpo es un estado aceptable.
function invalidState(body) {
  if (!body || !body.trim()) return 'cuerpo vacio';
  if (body.length > MAX_CHARS) return 'estado demasiado grande';
  let data;
  try { data = JSON.parse(body); } catch { return 'JSON invalido'; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'se esperaba un objeto';
  const missing = REQUIRED.filter(k => !(k in data));
  if (missing.length) return 'faltan claves: ' + missing.join(', ');
  if (!Array.isArray(data.goals)) return 'goals debe ser un array';
  return null;
}

// Una clave por usuario. El email ya viene normalizado y verificado por el JWT.
function stateKey(email) { return KV_KEY + ':' + email; }
function bakPrefix(email) { return BAK_PREFIX + email + ':'; }

// Migracion de la clave global unica al esquema por usuario. Corre una sola vez,
// para el email declarado en OWNER_EMAIL: son los datos que ya existian antes de
// que hubiera usuarios, y son suyos. Cualquier otro usuario empieza vacio.
async function adoptLegacy(kv, email, ownerEmail) {
  if (!ownerEmail || email !== String(ownerEmail).trim().toLowerCase()) return null;
  const legacy = await kv.get(KV_KEY);
  if (!legacy) return null;
  await kv.put(stateKey(email), legacy);
  // La global se conserva a proposito: si la migracion sale mal, el original sigue.
  return legacy;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Copia el estado vigente a una clave con fecha. expirationTtl la borra sola a los
// 7 dias, asi que no hace falta barrer nada.
async function backup(kv, email) {
  const raw = await kv.get(stateKey(email));
  if (!raw) return null;
  const day = today();
  await kv.put(bakPrefix(email) + day, raw, { expirationTtl: BAK_DAYS * 86400 });
  return day;
}

// A quien respaldar en el cron: se lleva un indice de los usuarios que han escrito
// alguna vez, porque KV no sabe listar "usuarios".
const USERS_KEY = KV_KEY + ':users';
async function knownUsers(kv) {
  const raw = await kv.get(USERS_KEY);
  try { const l = JSON.parse(raw || '[]'); return Array.isArray(l) ? l : []; }
  catch { return []; }
}
async function rememberUser(kv, email) {
  const list = await knownUsers(kv);
  if (list.includes(email)) return;
  await kv.put(USERS_KEY, JSON.stringify([...list, email].slice(0, 200)));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const email = await authEmail(request, env, ctx);
    if (!email) return json({ error: 'Unauthorized' }, 401);

    const url = new URL(request.url);
    const kv = env.PLANNER_KV;

    if (request.method === 'GET') {
      // Que respaldos hay disponibles para recuperar.
      if (url.searchParams.has('backups')) {
        const list = await kv.list({ prefix: bakPrefix(email) });
        return json({ backups: list.keys.map(k => k.name.slice(bakPrefix(email).length)).sort().reverse() });
      }
      // Leer un respaldo concreto sin tocar el estado vigente.
      const day = url.searchParams.get('backup');
      if (day) {
        const raw = await kv.get(bakPrefix(email) + day);
        if (!raw) return json({ error: 'no hay respaldo de ' + day }, 404);
        return json({ data: JSON.parse(raw), backup: day });
      }
      let raw = await kv.get(stateKey(email));
      if (raw === null) raw = await adoptLegacy(kv, email, env.OWNER_EMAIL);
      const data = raw ? JSON.parse(raw) : null;
      return json({ data });
    }

    if (request.method === 'POST') {
      // Restaurar un respaldo. Antes de pisar nada, guarda lo que hay ahora mismo,
      // por si la restauracion era el error.
      const day = url.searchParams.get('restore');
      if (day) {
        const raw = await kv.get(bakPrefix(email) + day);
        if (!raw) return json({ error: 'no hay respaldo de ' + day }, 404);
        await backup(kv, email);
        await kv.put(stateKey(email), raw);
        return json({ ok: true, restored: day });
      }

      const body = await request.text();
      const bad = invalidState(body);
      if (bad) return json({ error: 'estado rechazado: ' + bad }, 400);
      await kv.put(stateKey(email), body);
      await rememberUser(kv, email);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  },

  async scheduled(_event, env, ctx) {
    const kv = env.PLANNER_KV;
    ctx.waitUntil((async () => {
      for (const email of await knownUsers(kv)) {
        try { await backup(kv, email); } catch { /* un usuario no debe tumbar el barrido */ }
      }
    })());
  },
};
