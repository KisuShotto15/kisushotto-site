// api.js — shared API client

import { session, showLogin } from './auth.js';

const DEFAULT_BASE = 'https://trade-journal-worker.efrenalejandro2010.workers.dev';

// La credencial es el JWT del login, el mismo del resto del sitio. Caduca sola
// y va ligada a tu email; no hay secreto compartido en el bundle.
export const cfg = {
  base:  () => localStorage.getItem('tj_url') || DEFAULT_BASE,
  token: () => session.token(),
};

export async function api(path, opts = {}) {
  if (!cfg.token()) {
    showLogin();
    throw new Error('Sesion no iniciada');
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
  if (res.status === 401 || res.status === 403) {
    // Sesion caducada o revocada: se limpia y se vuelve a pedir login
    session.clear();
    showLogin('Tu sesion expiro. Vuelve a entrar.');
    throw new Error('Sesion expirada');
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
