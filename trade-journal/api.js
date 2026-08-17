// api.js — shared API client

const DEFAULT_BASE = 'https://trade-journal-worker.efrenalejandro2010.workers.dev';

// El token NO va en el codigo: este bundle es publico y cualquiera que lo abra
// se lo lleva. Se guarda una sola vez en el navegador de cada dispositivo.
export const cfg = {
  base:  () => localStorage.getItem('tj_url')   || DEFAULT_BASE,
  token: () => localStorage.getItem('tj_token') || '',
};

export function setToken(t) { localStorage.setItem('tj_token', t.trim()); }
export function hasToken()  { return !!cfg.token(); }

// Pide el token una vez por dispositivo. Vive aca para que lo hereden las
// cuatro paginas sin duplicar la pantalla en cada una.
export function askForToken(msg = 'Introduce el token de acceso') {
  if (document.getElementById('tj-token-gate')) return;
  const el = document.createElement('div');
  el.id = 'tj-token-gate';
  el.style.cssText = 'position:fixed;inset:0;background:#181818;display:flex;align-items:center;' +
    'justify-content:center;z-index:9999;padding:24px;font-family:Inter,sans-serif;color:#fff';
  el.innerHTML = `
    <div style="max-width:420px;width:100%">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:13px;letter-spacing:.12em;
        color:#00c896;text-transform:uppercase;margin-bottom:10px">// acceso</div>
      <div style="font-size:15px;color:#888;margin-bottom:18px">${msg}</div>
      <input id="tj-token-input" type="password" autocomplete="current-password" placeholder="token"
        style="width:100%;background:#242424;border:1px solid #3c3c3c;color:#fff;padding:12px 14px;
        border-radius:8px;font-family:'IBM Plex Mono',monospace;font-size:15px;outline:none">
      <button id="tj-token-ok" style="width:100%;margin-top:12px;background:#00c896;border:none;
        color:#181818;font-weight:700;padding:12px;border-radius:8px;cursor:pointer;font-size:15px">
        Entrar</button>
    </div>`;
  document.body.appendChild(el);

  const input = el.querySelector('#tj-token-input');
  const save  = () => { if (input.value.trim()) { setToken(input.value); location.reload(); } };
  el.querySelector('#tj-token-ok').onclick = save;
  input.onkeydown = e => { if (e.key === 'Enter') save(); };
  input.focus();
}

export async function api(path, opts = {}) {
  if (!cfg.token()) {
    askForToken();
    throw new Error('Falta el token de acceso');
  }
  const url = cfg.base() + path;
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${cfg.token()}`,
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(`No se puede conectar: ${url} — ${e.message}`);
  }
  if (res.status === 401) {
    // Token invalido o rotado: se descarta y se vuelve a pedir
    localStorage.removeItem('tj_token');
    askForToken('El token no es valido. Introducelo de nuevo.');
    throw new Error('Token invalido');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

const qs = (params) => {
  const p = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null && v !== ''));
  return Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : '';
};

export const getTrades       = (params)  => api(`/trades${qs(params)}`);
export const createTrade     = (body)    => api('/trades',  { method: 'POST', body: JSON.stringify(body) });
export const updateTrade     = (id, b)   => api(`/trades/${id}`, { method: 'PUT',  body: JSON.stringify(b) });
export const deleteTrade     = (id)      => api(`/trades/${id}`, { method: 'DELETE' });
export const getLivePositions = ()       => api('/positions/live');
export const getPlans        = ()        => api('/positions/plan');
export const savePlan        = (body)    => api('/positions/plan', { method: 'POST', body: JSON.stringify(body) });
export const getAnalytics    = (params)  => api(`/analytics${qs(params)}`);
export const getBySession    = ()        => api('/analytics/by-session');
export const getBySymbol     = (params)  => api(`/analytics/by-symbol${qs(params)}`);
export const getBySetup      = ()        => api('/analytics/by-setup');
export const getByStrategy   = ()        => api('/analytics/by-strategy');
export const getHeatmap      = ()        => api('/analytics/heatmap');
export const getWeekly       = (params)  => api(`/analytics/weekly${qs(params)}`);
export const bulkTag         = (body)    => api('/trades/bulk-tag', { method: 'POST', body: JSON.stringify(body) });

export async function downloadCSV(params) {
  const res = await fetch(cfg.base() + `/trades/export${qs(params)}`, {
    headers: { 'Authorization': `Bearer ${cfg.token()}` },
  });
  if (!res.ok) throw new Error(`Export ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a   = document.createElement('a');
  a.href = url;
  a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
export const getInsights     = ()        => api('/insights');
export const refreshInsights = ()        => api('/insights/refresh', { method: 'POST' });
export const getStrategies   = ()        => api('/strategies');
export const getSetups       = ()        => api('/setups');

export const ingestBybit        = (b) => api('/ingest/bybit',         { method: 'POST', body: JSON.stringify(b) });
export const ingestBybitInverse = (b) => api('/ingest/bybit-inverse', { method: 'POST', body: JSON.stringify(b) });
export const ingestBybitSpot    = (b) => api('/ingest/bybit-spot',    { method: 'POST', body: JSON.stringify(b) });
export const ingestBinance      = (b) => api('/ingest/binance',       { method: 'POST', body: JSON.stringify(b) });
export const ingestBinanceSpot  = (b) => api('/ingest/binance-spot',  { method: 'POST', body: JSON.stringify(b) });
export const ingestCSV          = (b) => api('/ingest/csv',           { method: 'POST', body: JSON.stringify(b) });
export const getSyncConfig      = ()  => api('/sync/config');
export const setSyncConfig      = (b) => api('/sync/config', { method: 'POST', body: JSON.stringify(b) });
export const runSync            = ()  => api('/sync/run',    { method: 'POST' });
