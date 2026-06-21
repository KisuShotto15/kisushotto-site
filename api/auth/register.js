import { cors } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { hashPassword, signJWT } from '../_lib/crypto.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';
import { isAllowed } from '../_lib/allowlist.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Email y password (min 8 caracteres) requeridos' });
  }
  const mail = String(email).trim().toLowerCase();

  const wait = rateLimit('reg:' + clientIp(req), 6, 3600000);
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'Demasiados registros, espera ' + Math.ceil(wait / 60) + ' min' });
  }

  if (!isAllowed(mail)) return res.status(403).json({ error: 'Email no autorizado' });
  try {
    await ensureSchema();
    const existing = await sql`SELECT id FROM users WHERE email = ${mail}`;
    if (existing.length) return res.status(409).json({ error: 'Email ya registrado' });
    const rows = await sql`INSERT INTO users (email, pass_hash) VALUES (${mail}, ${hashPassword(password)}) RETURNING id`;
    return res.status(200).json({ token: signJWT({ uid: rows[0].id, email: mail }) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
