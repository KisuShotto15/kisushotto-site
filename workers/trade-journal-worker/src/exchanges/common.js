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
