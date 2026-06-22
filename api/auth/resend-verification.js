import { cors } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { randomToken } from '../_lib/crypto.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';
import { sendEmail, appUrl, verifyEmailHtml } from '../_lib/mail.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  if (!mail) return res.status(400).json({ error: 'Email requerido' });

  const wait = rateLimit('resend:' + clientIp(req), 5, 3600000);
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'Espera ' + Math.ceil(wait / 60) + ' min' });
  }

  try {
    await ensureSchema();
    const u = await sql`SELECT verified FROM users WHERE email = ${mail}`;
    if (u.length && !u[0].verified) {
      await sql`DELETE FROM auth_tokens WHERE email = ${mail} AND kind = 'verify'`;
      const token = randomToken();
      const exp = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await sql`INSERT INTO auth_tokens (token, email, kind, expires_at) VALUES (${token}, ${mail}, 'verify', ${exp})`;
      await sendEmail(mail, 'Verifica tu email — P2P Monitor', verifyEmailHtml(appUrl() + '/?verify=' + token));
    }
    return res.status(200).json({ ok: true }); // sin enumeracion de cuentas
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
