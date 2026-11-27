// Datos de Metricas (Body Metrics) por cuenta: se guardan en el backend de
// Health (habits-worker, /health/bodymetrics) con el token del usuario.
import { authFetch } from '../auth.js';
import { TEMPLATES, RENAMES } from '../rutina-data.js';

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

// Limpieza de las series que la Rutina guardo dos veces (boton "Ya" doble o justo
// al terminar el descanso, nov 2026). En una superserie, la misma serie (ejercicio
// y lado) dos veces seguidas solo puede ser ese error: entre una y otra siempre va
// el otro ejercicio o el otro lado. Devuelve cuantas borro (0 = nada que tocar).
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
export function dedupeRutina(state) {
  // de paso: los ejercicios de la rutina A/B pasaron a ingles (el historial sigue, es el mismo id)
  for (const e of state?.exercises || []) if (RENAMES[e.name]) { e.name = RENAMES[e.name]; state.lastModified = Date.now(); state._renamed = 1; }
  if (!state?.sessions?.length) { const r = state?._renamed ? 1 : 0; if (state) delete state._renamed; return r; }
  const ss = new Set();
  const add = list => (list || []).forEach(it => { if (it.ss) ss.add(norm(it.name)); });
  TEMPLATES.forEach(t => add(t.items));
  try { (JSON.parse(localStorage.getItem('health_rutina_v1'))?.routines || []).forEach(r => add(r.items)); } catch {}
  const nameOf = {}; (state.exercises || []).forEach(e => { nameOf[e.id] = norm(e.name); });
  let removed = 0;
  for (const s of state.sessions) {
    if (s.from !== 'rutina' || s.date < '2026-11-15') continue;
    const keep = [];
    for (const z of s.sets) {
      const prev = keep[keep.length - 1];
      if (prev && prev.exerciseId === z.exerciseId && (prev.side || null) === (z.side || null) && ss.has(nameOf[z.exerciseId])) { removed++; continue; }
      keep.push(z);
    }
    s.sets = keep;
  }
  if (removed) state.lastModified = Date.now();
  const renamed = state._renamed; delete state._renamed;
  return removed || (renamed ? -1 : 0); // -1: solo nombres cambiados
}

function retryPending() {
  if (!navigator.onLine || !localStorage.getItem(DIRTY_KEY)) return;
  const local = loadLocal();
  if (local) push(local);
}
addEventListener('online', retryPending);
retryPending();
