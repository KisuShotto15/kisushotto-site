// Utilidades compartidas por los adaptadores de exchange.

export async function hmacRaw(secret, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
export const base64 = bytes => btoa(String.fromCharCode(...bytes));

// Numero a string sin notacion cientifica, con los decimales del paso
export function fmt(v, step) {
  const dec = step > 0 ? Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) : 8;
  return (+v).toFixed(Math.min(dec, 12));
}

export const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export const STABLES = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDE', 'DAI']);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Lista de una respuesta que a veces es un arreglo y a veces {list|orders|rows: []}
export const listOf = d => Array.isArray(d) ? d : (d?.list || d?.orders || d?.rows || d?.entrustedList || d?.orderList || []);

// ── Transporte ───────────────────────────────────────────────────────────────
// Binance y Bitget bloquean las IPs de Cloudflare Workers. Las llamadas salen
// por un relay en Vercel (api/exchange-relay.js). Las que se piden en el mismo
// instante viajan juntas en un solo POST para gastar menos invocaciones.

let transport = (url, init) => fetch(url, init);

export const xfetch = (url, init) => transport(String(url), init);

export function canonical(ts, reqs) {
  return `${ts}\n` + reqs.map(r => `${r.method}\n${r.url}\n${JSON.stringify(r.headers || {})}\n${r.body || ''}`).join('\n--\n');
}

export function useRelay(relayUrl, jwtSecret, { batchMs = 8, maxBatch = 20 } = {}) {
  let queue = [], timer = null, keyBytes = null;

  async function key() {
    if (!keyBytes) keyBytes = await hmacRaw(jwtSecret, 'exchange-relay-v1');
    return keyBytes;
  }

  async function sign(message) {
    const k = await crypto.subtle.importKey('raw', await key(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))));
  }

  async function flush() {
    timer = null;
    const batch = queue.splice(0, maxBatch);
    if (queue.length) timer = setTimeout(flush, 0);
    const ts = Date.now();
    const reqs = batch.map(x => x.req);
    try {
      const res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Sig': await sign(canonical(ts, reqs)) },
        body: JSON.stringify({ ts, reqs }),
      });
      if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const { res: out } = await res.json();
      batch.forEach((x, i) => {
        const st = out[i].status === 599 ? 502 : out[i].status;
        x.resolve(new Response([101, 204, 205, 304].includes(st) ? null : out[i].body, { status: st }));
      });
    } catch (e) {
      batch.forEach(x => x.reject(e));
    }
  }

  transport = (url, init = {}) => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    queue.push({ req: { method: init.method || 'GET', url, headers, body: init.body || '' }, resolve, reject });
    if (queue.length >= maxBatch) { clearTimeout(timer); flush(); }
    else if (!timer) timer = setTimeout(flush, batchMs);
  });
}
