// Sincronizacion de Nutrición. La identidad es el JWT del sitio: antes iba un token
// compartido ('151322') escrito aqui mismo, que el navegador descarga y cualquiera
// podia leer para entrar a los datos de todos.
import { requireSession, makeAuthFetch } from '../shared/site-auth.js';

const DATA_URL = 'https://nutrition-data-worker.efrenalejandro2010.workers.dev';
const LS_KEY   = 'nutrition_v1';
const APP      = { app: 'Nutrición', prefix: 'nutrition' };

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
  try {
    const r = await afetch(DATA_URL);
    if (!r.ok) return null;
    const res = await r.json();
    return res.data || null;
  } catch { return null; }
}

// El worker ahora RECHAZA un estado con la forma equivocada en vez de guardarlo:
// un fallo aqui deja intacto lo que hay en la nube, y lo local sigue en su sitio.
export async function push(state) {
  try {
    await afetch(DATA_URL, {
      method: 'POST',
      keepalive: true, // sobrevive al cierre de la pestana (flush en pagehide)
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
  } catch {}
}
