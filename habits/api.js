// api.js — habits worker client

const DEFAULT_BASE  = 'https://habits-worker.efrenalejandro2010.workers.dev';
const DEFAULT_TOKEN = '151322';

export const cfg = {
  base:  () => localStorage.getItem('habits_url')   || DEFAULT_BASE,
  token: () => localStorage.getItem('habits_token') || DEFAULT_TOKEN,
};

// Read user email from Cloudflare Access JWT cookie (CF_Authorization)
// Falls back to localStorage override for local dev (no CF Access)
function getUserEmail() {
  const override = localStorage.getItem('habits_user');
  if (override) return override;

  const raw = document.cookie.split(';').map(c => c.trim())
    .find(c => c.startsWith('CF_Authorization='));
  if (!raw) return null;

  try {
    const token   = raw.split('=').slice(1).join('=');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function api(path, opts = {}) {
  const url   = cfg.base() + path;
  const email = getUserEmail();
  if (!email) throw new Error('No se pudo identificar el usuario. Abre la app desde el dominio protegido.');

  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cfg.token()}`,
        'X-User-Email':  email,
        ...(opts.headers || {}),
      },
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

export const getHabits      = ()      => api('/habits');
export const createHabit    = b       => api('/habits', { method: 'POST', body: JSON.stringify(b) });
export const updateHabit    = (id, b) => api(`/habits/${id}`, { method: 'PUT', body: JSON.stringify(b) });
export const deleteHabit    = id      => api(`/habits/${id}`, { method: 'DELETE' });

export const getCompletions = p       => api(`/completions${qs(p)}`);
export const toggleComplete = b       => api('/completions/toggle', { method: 'POST', body: JSON.stringify(b) });
export const setComplete    = b       => api('/completions/set',    { method: 'POST', body: JSON.stringify(b) });

export const getStats       = p       => api(`/stats${qs(p)}`);
