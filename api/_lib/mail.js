// Envio de email via Resend (REST, sin SDK). Requiere RESEND_API_KEY y MAIL_FROM.
// MAIL_FROM ej: "P2P Monitor <noreply@kisushotto.com>" (dominio verificado en Resend).
export function appUrl() {
  return (process.env.APP_URL || 'https://p2p.kisushotto.com').replace(/\/$/, '');
}

export async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error('Email no configurado (RESEND_API_KEY / MAIL_FROM)');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Resend ' + r.status + ': ' + t.slice(0, 200));
  }
  return true;
}

function shell(title, intro, link, btn, note) {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
    <h2 style="color:#0d0f14;margin:0 0 12px">${title}</h2>
    <p style="margin:0 0 8px">${intro}</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#F0B90B;color:#0d0f14;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">${btn}</a></p>
    <p style="font-size:13px;color:#666;word-break:break-all">O copia este enlace:<br>${link}</p>
    <p style="font-size:12px;color:#999;margin-top:18px">${note}</p>
  </div>`;
}

export function verifyEmailHtml(link) {
  return shell('Verifica tu email', 'Confirma tu cuenta de P2P Monitor para empezar a usarla.', link, 'Verificar email',
    'El enlace expira en 24 horas. Si no creaste esta cuenta, ignora este correo.');
}

export function resetEmailHtml(link) {
  return shell('Restablecer contraseña', 'Recibimos una solicitud para cambiar tu contraseña.', link, 'Cambiar contraseña',
    'El enlace expira en 1 hora. Si no lo solicitaste, ignora este correo.');
}
