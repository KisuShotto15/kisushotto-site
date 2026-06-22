// Ruta dinamica: /api/auth/<action> → 1 sola funcion serverless (limite Hobby de Vercel).
// Acciones: register, login, me, verify-email, resend-verification, forgot-password, reset-password.
import { cors, requireAllowedUser } from '../_lib/auth.js';
import { sql, ensureSchema } from '../_lib/db.js';
import { hashPassword, verifyPassword, signJWT, randomToken } from '../_lib/crypto.js';
import { rateLimit, clientIp } from '../_lib/ratelimit.js';
import { isAllowed } from '../_lib/allowlist.js';
import { sendEmail, appUrl, verifyEmailHtml, resetEmailHtml } from '../_lib/mail.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = String(req.query.action || '');
  try {
    switch (action) {
      case 'register':           return await register(req, res);
      case 'login':              return await login(req, res);
      case 'me':                 return await me(req, res);
      case 'verify-email':       return await verifyEmail(req, res);
      case 'resend-verification':return await resendVerification(req, res);
      case 'forgot-password':    return await forgotPassword(req, res);
      case 'reset-password':     return await resetPassword(req, res);
      default:                   return res.status(404).json({ error: 'Accion desconocida' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function tokenExp(ms) { return new Date(Date.now() + ms).toISOString(); }

async function register(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Email y password (min 8 caracteres) requeridos' });
  }
  const mail = String(email).trim().toLowerCase();

  const wait = rateLimit('reg:' + clientIp(req), 6, 3600000);
  if (wait !== null) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Demasiados registros, espera ' + Math.ceil(wait / 60) + ' min' }); }

  if (!isAllowed(mail)) return res.status(403).json({ error: 'Email no autorizado' });
  await ensureSchema();
  const existing = await sql`SELECT id FROM users WHERE email = ${mail}`;
  if (existing.length) return res.status(409).json({ error: 'Email ya registrado' });
  await sql`INSERT INTO users (email, pass_hash, verified) VALUES (${mail}, ${hashPassword(password)}, false)`;

  const token = randomToken();
  await sql`INSERT INTO auth_tokens (token, email, kind, expires_at) VALUES (${token}, ${mail}, 'verify', ${tokenExp(24 * 3600 * 1000)})`;
  try {
    await sendEmail(mail, 'Verifica tu email — P2P Monitor', verifyEmailHtml(appUrl() + '/?verify=' + token));
  } catch (e) {
    return res.status(200).json({ ok: true, needVerify: true, emailError: e.message });
  }
  return res.status(200).json({ ok: true, needVerify: true });
}

async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y password requeridos' });
  const mail = String(email).trim().toLowerCase();

  const ip = clientIp(req);
  const wait = rateLimit('login:' + ip, 12, 600000) || rateLimit('login:' + ip + ':' + mail, 6, 600000);
  if (wait !== null) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Demasiados intentos, espera ' + wait + 's' }); }

  if (!isAllowed(mail)) return res.status(403).json({ error: 'Email no autorizado' });
  await ensureSchema();
  const rows = await sql`SELECT id, pass_hash, verified FROM users WHERE email = ${mail}`;
  if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
    return res.status(401).json({ error: 'Credenciales invalidas' });
  }
  if (!rows[0].verified) return res.status(403).json({ error: 'Verifica tu email antes de entrar', needVerify: true });
  return res.status(200).json({ token: signJWT({ uid: rows[0].id, email: mail }) });
}

async function me(req, res) {
  let user;
  try { user = requireAllowedUser(req); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  return res.status(200).json({ email: user.email });
}

async function verifyEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token requerido' });
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
}

async function resendVerification(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  if (!mail) return res.status(400).json({ error: 'Email requerido' });
  const wait = rateLimit('resend:' + clientIp(req), 5, 3600000);
  if (wait !== null) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Espera ' + Math.ceil(wait / 60) + ' min' }); }
  await ensureSchema();
  const u = await sql`SELECT verified FROM users WHERE email = ${mail}`;
  if (u.length && !u[0].verified) {
    await sql`DELETE FROM auth_tokens WHERE email = ${mail} AND kind = 'verify'`;
    const token = randomToken();
    await sql`INSERT INTO auth_tokens (token, email, kind, expires_at) VALUES (${token}, ${mail}, 'verify', ${tokenExp(24 * 3600 * 1000)})`;
    await sendEmail(mail, 'Verifica tu email — P2P Monitor', verifyEmailHtml(appUrl() + '/?verify=' + token));
  }
  return res.status(200).json({ ok: true });
}

async function forgotPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const mail = String((req.body || {}).email || '').trim().toLowerCase();
  if (!mail) return res.status(400).json({ error: 'Email requerido' });
  const wait = rateLimit('forgot:' + clientIp(req), 5, 3600000);
  if (wait !== null) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'Espera ' + Math.ceil(wait / 60) + ' min' }); }
  await ensureSchema();
  const u = await sql`SELECT id FROM users WHERE email = ${mail}`;
  if (u.length) {
    await sql`DELETE FROM auth_tokens WHERE email = ${mail} AND kind = 'reset'`;
    const token = randomToken();
    await sql`INSERT INTO auth_tokens (token, email, kind, expires_at) VALUES (${token}, ${mail}, 'reset', ${tokenExp(3600 * 1000)})`;
    await sendEmail(mail, 'Restablecer contraseña — P2P Monitor', resetEmailHtml(appUrl() + '/?reset=' + token));
  }
  return res.status(200).json({ ok: true });
}

async function resetPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 8) return res.status(400).json({ error: 'Token y password (min 8 caracteres) requeridos' });
  await ensureSchema();
  const rows = await sql`SELECT email, expires_at FROM auth_tokens WHERE token = ${token} AND kind = 'reset'`;
  if (!rows.length) return res.status(400).json({ error: 'Enlace invalido o ya usado' });
  if (new Date(rows[0].expires_at) < new Date()) {
    await sql`DELETE FROM auth_tokens WHERE token = ${token}`;
    return res.status(400).json({ error: 'Enlace expirado, solicita uno nuevo' });
  }
  const mail = rows[0].email;
  await sql`UPDATE users SET pass_hash = ${hashPassword(password)}, verified = true WHERE email = ${mail}`;
  await sql`DELETE FROM auth_tokens WHERE token = ${token}`;
  const out = { ok: true, email: mail };
  const u = await sql`SELECT id FROM users WHERE email = ${mail}`;
  if (u.length && isAllowed(mail)) out.token = signJWT({ uid: u[0].id, email: mail });
  return res.status(200).json(out);
}
