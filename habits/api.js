// api.js — habits worker client
//
// La identidad es el JWT del sitio. Antes era la cabecera X-User-Email, que
// escribia este mismo archivo: "iniciar sesion" era teclear un email, sin
// contrasena, y el token del worker venia escrito aqui a la vista de cualquiera.
import { requireSession, makeAuthFetch } from '../shared/site-auth.js';

const DEFAULT_BASE = 'https://habits-worker.efrenalejandro2010.workers.dev';
const APP = { app: 'Habit Tracker', prefix: 'habits' };

export const cfg = {
  base: () => localStorage.getItem('habits_url') || DEFAULT_BASE,
};

let session = null;
let afetch = null;

// Hay que llamarlo antes que nada: no resuelve hasta que hay sesion.
export async function initAuth() {
  session = await requireSession(APP);
  afetch = makeAuthFetch(session, APP);
  return session;
}

export function getUserEmail() {
  return session ? session.email() : null;
}

async function api(path, opts = {}) {
  if (!afetch) throw new Error('LOGIN_REQUIRED');
  const url = cfg.base() + path;

  let res;
  try {
    res = await afetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  } catch (e) {
    throw new Error(`No se puede conectar: ${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

const qs = p => {
  const clean = Object.fromEntries(Object.entries(p || {}).filter(([,v]) => v != null));
  return Object.keys(clean).length ? '?' + new URLSearchParams(clean) : '';
};

export const getHabits      = today   => api('/habits' + (today ? `?today=${today}` : ''));
export const createHabit    = b       => api('/habits', { method: 'POST', body: JSON.stringify(b) });
export const updateHabit    = (id, b) => api(`/habits/${id}`, { method: 'PUT', body: JSON.stringify(b) });
export const deleteHabit    = id      => api(`/habits/${id}`, { method: 'DELETE' });

export const getCompletions = p       => api(`/completions${qs(p)}`);
export const toggleComplete = b       => api('/completions/toggle', { method: 'POST', body: JSON.stringify(b) });
export const setComplete    = b       => api('/completions/set',    { method: 'POST', body: JSON.stringify(b) });

export const getStats       = p       => api(`/stats${qs(p)}`);

export const apiVapid    = ()    => api('/vapid');
export const apiSetPush  = sub   => api('/me/push', { method: 'POST', body: JSON.stringify(sub) });
