// Cifrado de credenciales en reposo, para los workers.
//
// Mismo esquema que api/_lib/crypto.js (AES-256-GCM con una clave maestra de 32
// bytes en hex), pero con WebCrypto: en Workers no hay node:crypto.
//
// Las claves de Binance de cada usuario ya se guardaban cifradas en Postgres; las
// de Bybit del diario de trading estaban en texto plano en D1. Cualquiera con
// acceso de lectura a esa base — un token de Cloudflare filtrado, una copia de
// seguridad, un error de configuracion — se llevaba credenciales operativas.
//
// Formato: "v1:<iv en base64>:<ciphertext+tag en base64>". El prefijo permite
// distinguir lo ya cifrado de lo que quedo en claro de antes, y migrarlo al vuelo.

const PREFIX = 'v1:';

function b64(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unb64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function masterKey(env) {
  const hex = String(env.CRED_ENC_KEY || '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CRED_ENC_KEY debe ser 32 bytes en hex (64 caracteres)');
  }
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Lo que ya viene cifrado se reconoce por el prefijo. Una clave de Bybit es
// alfanumerica, asi que no puede confundirse con esto.
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export async function encryptSecret(env, plain) {
  const key = await masterKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plain)));
  return PREFIX + b64(iv) + ':' + b64(ct);
}

// Descifra. Lo que no lleve el prefijo se devuelve tal cual: es una fila anterior
// al cifrado y hay que poder seguir usandola mientras se migra.
export async function decryptSecret(env, value) {
  if (!isEncrypted(value)) return value;
  const [, ivB64, ctB64] = value.split(':');
  const key = await masterKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(plain);
}
