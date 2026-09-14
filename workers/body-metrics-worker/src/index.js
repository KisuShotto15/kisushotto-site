// body-metrics-worker — estado de Body Metrics en una clave de KV.
//
// Dos protecciones sobre el diseño original, que era "escribe en KV lo que llegue":
//
//  1. Validacion antes de escribir. Un POST vacio o con un cuerpo malformado
//     sobrescribia el estado entero, y no habia vuelta atras: una sola clave, sin
//     versiones. Ahora un cuerpo que no parsee, que no sea un objeto o al que le
//     falten las claves de la app se rechaza con 400 y NO toca lo guardado.
//  2. Respaldo diario (cron 04:00 UTC) con expiracion automatica a 7 dias. Un
//     borrado accidental deja de ser definitivo.

const TOKEN = '151322';
const KV_KEY = 'body-metrics-state';
const BAK_PREFIX = 'body-metrics-state-bak-';
const BAK_DAYS = 7;
// Tope de tamano: el estado real son decenas de KB. Un cuerpo enorme solo puede
// ser un error o un abuso. Se mide en caracteres, no en bytes: sobra para el fin.
const MAX_CHARS = 2 * 1024 * 1024;
// Claves que el cliente siempre manda (ver `let S = ...` en body-metrics/index.html).
// Si faltan, lo que llego no es el estado de Body Metrics.
const REQUIRED = ['bodyComp', 'sessions', 'exercises', 'lastModified'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function auth(request) {
  return request.headers.get('Authorization') === `Bearer ${TOKEN}`;
}

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
  for (const k of ['bodyComp', 'sessions', 'exercises']) {
    if (!Array.isArray(data[k])) return k + ' debe ser un array';
  }
  return null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Copia el estado vigente a una clave con fecha. expirationTtl la borra sola a los
// 7 dias, asi que no hace falta barrer nada.
async function backup(kv) {
  const raw = await kv.get(KV_KEY);
  if (!raw) return null;
  const day = today();
  await kv.put(BAK_PREFIX + day, raw, { expirationTtl: BAK_DAYS * 86400 });
  return day;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!auth(request)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(request.url);

    if (request.method === 'GET') {
      // Que respaldos hay disponibles para recuperar.
      if (url.searchParams.has('backups')) {
        const list = await env.BODY_METRICS_KV.list({ prefix: BAK_PREFIX });
        return json({ backups: list.keys.map(k => k.name.slice(BAK_PREFIX.length)).sort().reverse() });
      }
      // Leer un respaldo concreto sin tocar el estado vigente.
      const day = url.searchParams.get('backup');
      if (day) {
        const raw = await env.BODY_METRICS_KV.get(BAK_PREFIX + day);
        if (!raw) return json({ error: 'no hay respaldo de ' + day }, 404);
        return json({ data: JSON.parse(raw), backup: day });
      }
      const raw = await env.BODY_METRICS_KV.get(KV_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return json({ data });
    }

    if (request.method === 'POST') {
      // Restaurar un respaldo. Antes de pisar nada, guarda lo que hay ahora mismo,
      // por si la restauracion era el error.
      const day = url.searchParams.get('restore');
      if (day) {
        const raw = await env.BODY_METRICS_KV.get(BAK_PREFIX + day);
        if (!raw) return json({ error: 'no hay respaldo de ' + day }, 404);
        await backup(env.BODY_METRICS_KV);
        await env.BODY_METRICS_KV.put(KV_KEY, raw);
        return json({ ok: true, restored: day });
      }

      const body = await request.text();
      const bad = invalidState(body);
      if (bad) return json({ error: 'estado rechazado: ' + bad }, 400);
      await env.BODY_METRICS_KV.put(KV_KEY, body);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(backup(env.BODY_METRICS_KV));
  },
};
