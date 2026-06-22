import { cors } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { hashPassword, signJWT } from '../_lib/crypto.js';
import { isAllowed } from '../_lib/allowlist.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Token y password (min 8 caracteres) requeridos' });
  }

  try {
    await ensureSchema();
    const rows = await sql`SELECT email, expires_at FROM auth_tokens WHERE token = ${token} AND kind = 'reset'`;
    if (!rows.length) return res.status(400).json({ error: 'Enlace invalido o ya usado' });
    if (new Date(rows[0].expires_at) < new Date()) {
      await sql`DELETE FROM auth_tokens WHERE token = ${token}`;
      return res.status(400).json({ error: 'Enlace expirado, solicita uno nuevo' });
    }
    const mail = rows[0].email;
    // Cambiar password tambien verifica el email (probo control de la bandeja).
    await sql`UPDATE users SET pass_hash = ${hashPassword(password)}, verified = true WHERE email = ${mail}`;
    await sql`DELETE FROM auth_tokens WHERE token = ${token}`;

    const out = { ok: true, email: mail };
    const u = await sql`SELECT id FROM users WHERE email = ${mail}`;
    if (u.length && isAllowed(mail)) out.token = signJWT({ uid: u[0].id, email: mail });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
