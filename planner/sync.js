const DATA_URL = 'https://planner-worker.efrenalejandro2010.workers.dev';
const TOKEN    = '151322';
const LS_KEY   = 'planner_v1';

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
  const r = await fetch(DATA_URL, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!r.ok) throw new Error('pull failed: ' + r.status);
  const res = await r.json();
  return res.data || null;
}

export async function push(state) {
  const r = await fetch(DATA_URL, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(state)
  });
  if (!r.ok) throw new Error('push failed: ' + r.status);
}
