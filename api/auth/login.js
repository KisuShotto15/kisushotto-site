import { cors } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { verifyPassword, signJWT } from '../_lib/crypto.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });
  const mail = String(email).trim().toLowerCase();
  try {
    await ensureSchema();
    const rows = await sql`SELECT id, pass_hash FROM users WHERE email = ${mail}`;
    if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    return res.status(200).json({ token: signJWT({ uid: rows[0].id, email: mail }) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
