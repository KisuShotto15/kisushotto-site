// api.js — shared API client

const DEFAULT_BASE  = 'https://trade-journal-worker.efrenalejandro2010.workers.dev';
const DEFAULT_TOKEN = '151322';

export const cfg = {
  base:  () => localStorage.getItem('tj_url')   || DEFAULT_BASE,
  token: () => localStorage.getItem('tj_token') || DEFAULT_TOKEN,
};

export async function api(path, opts = {}) {
  const res = await fetch(cfg.base() + path, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${cfg.token()}`,
      ...(opts.headers || {}),
    },
  });
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
export const getAnalytics    = (params)  => api(`/analytics${qs(params)}`);
export const getBySession    = ()        => api('/analytics/by-session');
export const getBySymbol     = ()        => api('/analytics/by-symbol');
export const getBySetup      = ()        => api('/analytics/by-setup');
export const getByStrategy   = ()        => api('/analytics/by-strategy');
export const getHeatmap      = ()        => api('/analytics/heatmap');
export const getInsights     = ()        => api('/insights');
export const refreshInsights = ()        => api('/insights/refresh', { method: 'POST' });
export const getStrategies   = ()        => api('/strategies');
export const getSetups       = ()        => api('/setups');

export const ingestBybit        = (b) => api('/ingest/bybit',         { method: 'POST', body: JSON.stringify(b) });
export const ingestBybitInverse = (b) => api('/ingest/bybit-inverse', { method: 'POST', body: JSON.stringify(b) });
export const ingestBybitSpot    = (b) => api('/ingest/bybit-spot',    { method: 'POST', body: JSON.stringify(b) });
export const ingestBinance      = (b) => api('/ingest/binance',       { method: 'POST', body: JSON.stringify(b) });
export const ingestBinanceSpot  = (b) => api('/ingest/binance-spot',  { method: 'POST', body: JSON.stringify(b) });
