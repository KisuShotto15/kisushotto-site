// Decide si una transaccion de Binance Pay corresponde a lo que el usuario declaro
// al avisar su pago. Separado de pay-poll.js (que arrastra la base de datos) para
// poder testearlo suelto.
//
// SOLO el Order ID confirma sola una factura. El nombre del pagador se conserva,
// pero como PISTA para la revision manual, nunca como criterio automatico.
//
// Por que: la cuenta que recibe estos pagos es la de un operador de P2P, donde
// entran cobros de USDT todo el dia, y los montos de suscripcion son fijos y
// redondos (70 y 700 USDT). Emparejar por monto + nombre significaba que el primer
// cobro entrante de exactamente 70 USDT de cualquier persona cuyo nombre encajara
// activaba la suscripcion de quien lo hubiera declarado. Y encajaba de sobra: la
// comparacion aceptaba que uno fuera PREFIJO del otro con 5 caracteres, asi que
// declarar "Carlos" bastaba para quedarse con el pago de cualquier Carlos... —
// incluido el de otro cliente, que ademas se quedaba sin su suscripcion y con su
// transaccion ya marcada como usada.
//
// El Order ID identifica UNA transaccion. No hay heuristica que valga, y adivinar
// 18 digitos ajenos no es una via realista.

// Longitud minima para que un identificador sirva.
const MIN_LEN = 5;

export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
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

// El "Order ID" que Binance le muestra al pagador al terminar (450541395316375552)
// llega en el campo orderId, que NO esta en la documentacion y NO es el
// transactionId (P_A23YT42NEJD71118). Se aceptan los dos: uno es el que el usuario
// puede copiar, el otro por si alguna transaccion solo trae ese.
export function orderMatches(t, ref) {
  const want = norm(ref);
  if (want.length < MIN_LEN) return false;
  return [t && t.orderId, t && t.transactionId]
    .map(norm)
    .some(id => id.length >= MIN_LEN && id === want);
}

// Coincidencia de nombre. Ya NO confirma nada: solo ordena los candidatos que se
// le muestran al admin en el panel de revision, para que no tenga que ir a buscar
// el pago a mano en Binance. Exacta tras normalizar — el prefijo era justo lo que
// hacia que "Carlos" se llevara el pago de "Carlos Rodriguez".
export function payerLooksLike(t, ref) {
  const want = norm(ref);
  if (want.length < MIN_LEN) return false;
  return payerNames(t).some(n => n === want);
}

// Criterio de la reconciliacion automatica: el Order ID, y nada mas.
export function refMatches(t, ref) {
  return orderMatches(t, ref);
}
