// Sincronizacion de Planner. La identidad es el JWT del sitio: antes iba un token
// compartido ('151322') escrito aqui mismo, que el navegador descarga y cualquiera
// podia leer para entrar a los datos de todos.
import { requireSession, makeAuthFetch } from '../shared/site-auth.js';

const DATA_URL = 'https://planner-worker.efrenalejandro2010.workers.dev';
const LS_KEY   = 'planner_v1';
const APP      = { app: 'Planner', prefix: 'planner' };

let afetch = null;

// Hay que llamarlo antes de pull/push: no resuelve hasta que hay sesion.
export async function initAuth() {
  const session = await requireSession(APP);
  afetch = makeAuthFetch(session, APP);
  return session;
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveLocal(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

export async function pull() {
  const r = await afetch(DATA_URL);
  if (!r.ok) throw new Error('pull failed: ' + r.status);
  const res = await r.json();
  return res.data || null;
}

export async function push(state) {
  const r = await afetch(DATA_URL, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  });
  if (!r.ok) throw new Error('push failed: ' + r.status);
}
