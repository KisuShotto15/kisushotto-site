import crypto from 'node:crypto';

// ── Master key para cifrar credenciales (AES-256-GCM) ──
// CRED_ENC_KEY = 32 bytes en hex (64 chars). Generar: openssl rand -hex 32
function getKey() {
  const buf = Buffer.from(process.env.CRED_ENC_KEY || '', 'hex');
  if (buf.length !== 32) throw new Error('CRED_ENC_KEY debe ser 32 bytes en hex (64 chars)');
  return buf;
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { ct: ct.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

export function decrypt({ ct, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]).toString('utf8');
}

// ── Password hashing (scrypt) ──
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

export function verifyPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return hash.length === hb.length && crypto.timingSafeEqual(hash, hb);
}

// ── JWT HS256 (sin dependencias) ──
function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET no configurado');
  return s;
}

export function signJWT(payload, ttlSeconds = 7 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', jwtSecret()).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + sig;
}

export function verifyJWT(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', jwtSecret()).update(h + '.' + p).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('firma invalida');
  const body = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) throw new Error('token expirado');
  return body;
}
