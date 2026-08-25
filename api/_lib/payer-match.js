// Decide si una transaccion de Binance Pay corresponde a lo que el usuario declaro
// al avisar su pago. Separado de pay-poll.js (que arrastra la base de datos) para
// poder testearlo suelto, igual que binancepay-email.js.
//
// Lo mejor que puede dar el usuario es el Order ID del pago: identifica UNA
// transaccion, asi que la coincidencia es exacta y no hay heuristica que valga.
// El nombre queda de respaldo para quien no lo copie.

// Longitud minima para que un identificador sirva: por debajo de esto la
// comparacion se vuelve tan laxa que matchearia a cualquiera.
const MIN_LEN = 5;

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
    .filter(x => x.length >= MIN_LEN);
}

// Igualdad, o que el mas corto sea PREFIJO del mas largo con 5 caracteres minimo.
//
// Prefijo y no "contiene": con contiene, un pagador llamado "Ana" matcheaba a quien
// registro "Susana", y con nicks cortos eso pasa de verdad. El prefijo cubre los
// casos reales — "Melida19" contra "Melida", "Efren M" contra "Efren Mendoza" —
// sin abrir esa puerta.
export function payerMatches(t, nick) {
  const want = norm(nick);
  if (want.length < MIN_LEN) return false;
  return payerNames(t).some(n => {
    if (n === want) return true;
    const [corto, largo] = n.length <= want.length ? [n, want] : [want, n];
    return corto.length >= MIN_LEN && largo.startsWith(corto);
  });
}

// El Order ID que el usuario ve en Binance Pay contra el transactionId del
// historial. Exacto tras normalizar: Binance los muestra con prefijos y guiones
// (M_P_71800000001) que la gente copia de forma inconsistente.
export function orderMatches(t, ref) {
  const want = norm(ref);
  if (want.length < MIN_LEN) return false;
  const id = norm(t && t.transactionId);
  return !!id && id === want;
}

// Criterio unico de la reconciliacion: el Order ID si lo dio, el nombre si no.
export function refMatches(t, ref) {
  return orderMatches(t, ref) || payerMatches(t, ref);
}
