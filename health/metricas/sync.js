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

export async function push(state) {
  try {
    await authFetch(DATA_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
  } catch {}
}
