import { verifyJWT } from './crypto.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Devuelve el payload del JWT (uid, email) o lanza un error con .status = 401.
export function requireUser(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) { const e = new Error('No autenticado'); e.status = 401; throw e; }
  try {
    return verifyJWT(m[1]);
  } catch (_) {
    const e = new Error('Sesion invalida'); e.status = 401; throw e;
  }
}
