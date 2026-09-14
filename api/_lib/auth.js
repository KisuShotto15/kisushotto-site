import { verifyJWT } from './crypto.js';
import { isAllowed } from './allowlist.js';
import { sql, ensureAuthColumns } from './db.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Revocacion de sesiones ───────────────────────────────────────────────────
// Un JWT no se puede retirar de circulacion, asi que /api/auth/revoke escribe una
// marca de tiempo en users.sessions_valid_from y todo lo emitido antes deja de
// valer. Esa comprobacion vivia SOLO dentro del manejador de /api/auth/me, asi que
// "cerrar sesion en todos los dispositivos" no cerraba nada: un token robado
// seguia sirviendo para operar el bot y para usar /api/binance-bot como proxy
// firmado hacia la cuenta de Binance del usuario, durante los 90 dias del token.
// Ahora se comprueba aqui, que es por donde pasa todo.
//
// Cache por instancia: /api/p2p-search se llama cada 15 s por usuario y no puede
// pagar un viaje a Postgres en cada refresco. El precio es que una revocacion
// tarda hasta 60 s en aplicarse, igual que ya ocurre con hasActiveSub.
const revokeCache = new Map(); // uid -> { validFrom, at }
const REVOKE_TTL_MS = 60 * 1000;

async function validFromFor(uid) {
  const hit = revokeCache.get(uid);
  if (hit && Date.now() - hit.at < REVOKE_TTL_MS) return hit.validFrom;

  const rows = await sql`SELECT sessions_valid_from FROM users WHERE id = ${uid}`;
  // Usuario borrado: se invalida todo lo suyo.
  const validFrom = rows.length ? Number(rows[0].sessions_valid_from || 0) : Infinity;
  if (revokeCache.size > 5000) revokeCache.clear();
  revokeCache.set(uid, { validFrom, at: Date.now() });
  return validFrom;
}

// Olvida lo cacheado de un usuario: lo llama /api/auth/revoke para que su propia
// respuesta no quede sirviendo un valor viejo durante un minuto.
export function forgetRevocation(uid) {
  revokeCache.delete(uid);
}

// La regla, aparte para poder probarla sola: un token vale si se emitio en o
// despues del corte. validFrom 0 = nunca se revoco nada. Infinity = el usuario ya
// no existe, asi que no vale ninguno de sus tokens.
export function sessionIsRevoked(iat, validFrom) {
  if (!validFrom) return false;
  return Number(iat || 0) < validFrom;
}

async function assertNotRevoked(user) {
  try {
    await ensureAuthColumns();
    const validFrom = await validFromFor(user.uid);
    if (sessionIsRevoked(user.iat, validFrom)) {
      const e = new Error('Sesion revocada');
      e.status = 401;
      e.revoked = true;
      throw e;
    }
  } catch (e) {
    if (e.status === 401) throw e;
    // La base no responde. Se deja pasar: cortarle el acceso a todo el mundo
    // durante una incidencia es peor que estirar unos minutos la ventana de una
    // revocacion. Mismo criterio que hasActiveSub, y queda anotado a proposito.
    return;
  }
}

// Devuelve el payload del JWT (uid, email) o lanza un error con .status = 401.
// Es async porque comprueba la revocacion contra la base.
export async function requireUser(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) { const e = new Error('No autenticado'); e.status = 401; throw e; }
  let user;
  try {
    user = verifyJWT(m[1]);
  } catch (_) {
    const e = new Error('Sesion invalida'); e.status = 401; throw e;
  }
  await assertNotRevoked(user);
  return user;
}

// Igual que requireUser pero ademas exige que el email este en la allowlist.
export async function requireAllowedUser(req) {
  const u = await requireUser(req);
  if (!isAllowed(u.email)) { const e = new Error('Email no autorizado'); e.status = 403; throw e; }
  return u;
}
