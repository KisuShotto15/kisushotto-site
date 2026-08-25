// Identifica al pagador de una transaccion de Binance Pay contra el nombre que el
// usuario registro. Separado de pay-poll.js (que arrastra la base de datos) para
// poder testearlo suelto, igual que binancepay-email.js.

export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Binance no siempre manda el mismo campo, asi que se juntan todos los que puedan
// identificar a la persona.
export function payerNames(t) {
  const p = (t && t.payerInfo) || {};
  return [p.name, p.nickName, p.accountId, p.binanceId, p.email]
    .map(norm)
    .filter(x => x.length >= 3);
}

// Laxo a proposito: el nombre que se ve en Binance ("Efren M.") rara vez coincide
// caracter a caracter con lo que el usuario escribe, pero uno contiene al otro.
// El minimo de 3 caracteres evita que un nombre cortisimo matchee con cualquiera.
export function payerMatches(t, nick) {
  const want = norm(nick);
  if (want.length < 3) return false;
  return payerNames(t).some(n => n.includes(want) || want.includes(n));
}
