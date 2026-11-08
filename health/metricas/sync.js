// Datos de Metricas (Body Metrics) por cuenta: se guardan en el backend de
// Health (habits-worker, /health/bodymetrics) con el token del usuario.
import { authFetch } from '../auth.js';

const DATA_URL = 'https://habits-worker.efrenalejandro2010.workers.dev/health/bodymetrics';
const LS_KEY   = 'body_metrics_v1';

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
    const r = await authFetch(DATA_URL);
    if (!r.ok) return null;
    const res = await r.json();
    return res.data || null;
  } catch { return null; }
}

// Si no hay conexion el cambio queda marcado y se reintenta al volver la red
// (o la proxima vez que se abra la app). Siempre se sube lo ultimo guardado.
const DIRTY_KEY = LS_KEY + '_dirty';
export async function push(state) {
  try {
    const r = await authFetch(DATA_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!r.ok) throw new Error(r.status);
    localStorage.removeItem(DIRTY_KEY);
  } catch { try { localStorage.setItem(DIRTY_KEY, '1'); } catch {} }
}

function retryPending() {
  if (!navigator.onLine || !localStorage.getItem(DIRTY_KEY)) return;
  const local = loadLocal();
  if (local) push(local);
}
addEventListener('online', retryPending);
retryPending();
