// Control de acceso por email.
//
// El registro es ABIERTO por defecto: quien llega crea su cuenta y la suscripcion
// (hasActiveSub) decide que puede usar. Antes esto era deny-all sin lista, lo que
// obligaba a meter cada cliente a mano en una env y redesplegar — imposible vender asi.
//
// ALLOWED_EMAILS queda solo para CERRAR el acceso a una lista concreta (beta
// privada, mantenimiento). Vacia, ausente o con "*" = abierto a todos.
export function isAllowed(email) {
  const list = String(process.env.ALLOWED_EMAILS || '')
    .split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.includes('*')) return true;
  return list.includes(String(email || '').trim().toLowerCase());
}
