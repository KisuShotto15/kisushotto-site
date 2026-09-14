// Identidad unica para todas las apps: el JWT que emite /api/auth/login en Vercel.
//
// Antes cada worker resolvia la identidad a su manera y ninguna servia:
//   · Notas y los tres workers de KV: un token compartido publicado en el bundle.
//   · Habitos: la cabecera X-User-Email, que escribe el propio cliente.
//   · Notas ademas emitia una sesion para cualquier email sin verificar nada.
// El worker del diario de trading ya lo hacia bien; esto es ese mismo patron,
// extraido para que lo usen todos.
//
// Se comprueba, en este orden: firma HS256 con JWT_SECRET, caducidad, que el email
// este en ALLOWED_EMAILS, y que la sesion no haya sido revocada.
//
// Variables que necesita cada worker:
//   JWT_SECRET       secret — el mismo valor que en Vercel
//   ALLOWED_EMAILS   var    — separados por coma/espacio. VACIA = NO PASA NADIE.
//   AUTH_BASE        var    — opcional, por si cambia el origen de la API

const DEFAULT_AUTH_BASE = 'https://kisushotto-site.vercel.app';
// Una revocacion tarda como mucho esto en aplicarse en los workers.
const REVOKE_TTL = 300;

// Comparacion en tiempo constante: una comparacion normal filtra por cuanto tarda
// en cortar, y con eso se puede reconstruir una firma byte a byte.
function eq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToB64url(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// HS256, igual que api/_lib/crypto.js pero con WebCrypto (no hay node:crypto aqui).
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
  if (!eq(sig, bytesToB64url(mac))) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))); }
  catch { return null; }

  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  if (!payload.email) return null;
  return payload;
}

// Lista vacia = no pasa nadie. Es lo contrario de api/_lib/allowlist.js, donde
// vacia significa "registro abierto": alli es un producto que se vende, aqui son
// apps personales y el default seguro es el cerrado.
export function isAllowed(email, list) {
  const allowed = String(list || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return false;
  return allowed.includes(String(email || '').trim().toLowerCase());
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// La firma y la caducidad se comprueban aqui, pero la revocacion vive en Postgres
// y solo Vercel la ve. Se consulta con cache para no pagar el viaje en cada peticion.
async function sessionRevoked(tok, env, ctx) {
  const base = env.AUTH_BASE || DEFAULT_AUTH_BASE;
  const key = new Request(`https://ks-auth.local/${await sha256hex(tok)}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return (await hit.json()).revoked;

  let revoked = false;
  try {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}` } });
    revoked = res.status === 401;
  } catch {
    // Si Vercel no responde no se cierra el paso: la firma y la caducidad ya se
    // validaron aqui. Se prefiere disponibilidad ante un fallo de red.
    return false;
  }

  const put = cache.put(key, new Response(JSON.stringify({ revoked }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${REVOKE_TTL}` },
  }));
  if (ctx) ctx.waitUntil(put); else await put;
  return revoked;
}

// Devuelve el email del usuario autenticado, o null. El email es la identidad:
// nunca se lee de una cabecera ni del cuerpo de la peticion.
export async function authEmail(request, env, ctx) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  const tok = m[1];
  if (!env.JWT_SECRET) return null;

  const payload = await verifyJWT(tok, env.JWT_SECRET);
  if (!payload) return null;
  if (!isAllowed(payload.email, env.ALLOWED_EMAILS)) return null;
  if (await sessionRevoked(tok, env, ctx)) return null;
  return String(payload.email).trim().toLowerCase();
}
