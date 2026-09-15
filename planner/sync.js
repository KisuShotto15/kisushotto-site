// Sincronizacion de Planner. La identidad es el JWT del sitio: antes iba un token
// compartido ('151322') escrito aqui mismo, que el navegador descarga y cualquiera
// podia leer para entrar a los datos de todos.
import { requireSession, makeAuthFetch } from '../shared/site-auth.js';

const DATA_URL = 'https://planner-worker.efrenalejandro2010.workers.dev';
const LS_KEY   = 'planner_v1';
const APP      = { app: 'Planner', prefix: 'planner' };

let afetch = null;

// Revision del estado tal como lo dejo el servidor la ultima vez que lo vimos.
// Se devuelve al guardar: si no coincide con la suya, alguien escribio en medio.
let rev = null;

// Que hacer cuando eso pasa. Lo registra la app al arrancar; sin handler, el
// estado remoto simplemente se descarta y el local sigue como estaba.
let onConflictCb = null;
export function onConflict(cb) { onConflictCb = cb; }

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
  rev = res.rev != null ? res.rev : null;
  return res.data || null;
}

// Guarda lo escrito y devuelve true si el servidor lo acepto.
//
// 409 = alguien guardo desde otro dispositivo despues de la ultima vez que
// leimos. En vez de pisarlo (que es lo que pasaba antes, sin aviso), se conserva
// lo nuestro en una copia de rescate por si hacia falta, se adopta lo del
// servidor y se avisa a la app para que se repinte.
async function send(state) {
  const q = rev != null ? '?rev=' + encodeURIComponent(rev) : '';
  const r = await afetch(DATA_URL + q, {
    method: 'POST',
    keepalive: true, // sobrevive al cierre de la pestana
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  });

  if (r.status === 409) {
    const d = await r.json().catch(() => ({}));
    rev = d.rev != null ? d.rev : null;
    try {
      localStorage.setItem(LS_KEY + '_rescate', JSON.stringify({ at: Date.now(), state }));
    } catch {}
    if (onConflictCb && d.data) onConflictCb(d.data);
    return false;
  }

  if (r.ok) {
    const d = await r.json().catch(() => ({}));
    if (d.rev != null) rev = d.rev;
    return true;
  }
  return false;
}

export async function push(state) {
  if (!(await send(state))) throw new Error('push rechazado');
}
