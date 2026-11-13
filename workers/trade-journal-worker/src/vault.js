// vault.js — las API keys con permiso de trading no se guardan en claro.
// AES-GCM con una llave derivada del secret KEYS_SECRET del worker
// (wrangler secret put KEYS_SECRET). Sin ese secret no se guardan llaves.

async function key(secret) {
  if (!secret || secret.length < 16) throw new Error('Falta el secret KEYS_SECRET en el worker (minimo 16 caracteres)');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function seal(plain, secret) {
  if (plain == null || plain === '') return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open(sealed, secret) {
  if (!sealed) return null;
  const [iv, ct] = sealed.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
