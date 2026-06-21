// Lista blanca de emails autorizados. Se configura en la env ALLOWED_EMAILS
// (separados por coma, espacio o salto de linea). Sin lista configurada = deny-all.
export function isAllowed(email) {
  const list = String(process.env.ALLOWED_EMAILS || '')
    .split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  return list.includes(String(email || '').trim().toLowerCase());
}
