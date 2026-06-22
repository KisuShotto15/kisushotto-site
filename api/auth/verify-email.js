import { cors } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { signJWT } from '../_lib/crypto.js';
import { isAllowed } from '../_lib/allowlist.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido' });

  try {
    await ensureSchema();
    const rows = await sql`SELECT email, expires_at FROM auth_tokens WHERE token = ${token} AND kind = 'verify'`;
    if (!rows.length) return res.status(400).json({ error: 'Enlace invalido o ya usado' });
    if (new Date(rows[0].expires_at) < new Date()) {
      await sql`DELETE FROM auth_tokens WHERE token = ${token}`;
      return res.status(400).json({ error: 'Enlace expirado, solicita uno nuevo' });
    }
    const mail = rows[0].email;
    await sql`UPDATE users SET verified = true WHERE email = ${mail}`;
    await sql`DELETE FROM auth_tokens WHERE token = ${token}`;

    const out = { ok: true, email: mail };
    const u = await sql`SELECT id FROM users WHERE email = ${mail}`;
    if (u.length && isAllowed(mail)) out.token = signJWT({ uid: u[0].id, email: mail });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
