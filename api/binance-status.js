import { cors, requireAllowedUser } from './_lib/auth.js';
import { sql, ensureSchema } from './_lib/db.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let user;
  try { user = requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    await ensureSchema();
    const rows = await sql`SELECT label, created_at FROM binance_creds WHERE user_id = ${user.uid}`;
    return res.status(200).json({ connected: rows.length > 0, label: rows[0] ? rows[0].label : null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
