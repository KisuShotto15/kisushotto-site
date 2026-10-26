// Lo que define el "mercado" de un usuario en el servidor: moneda (fiat), metodo de
// pago y zona horaria. Antes todo asumia VES, BancoDeVenezuela y America/Caracas.
export const DEFAULT_FIAT = 'VES';
export const DEFAULT_TZ = 'America/Caracas';

// Clave de las series hist24/hist_long (y del grafico). VES queda con el metodo a
// secas para no huerfanar el historial que ya existe; el resto lleva la moneda
// delante porque un mismo id de pago puede existir en varias monedas.
// Espejo de histKey() en public/p2p-monitor/main.js.
export function histKey(fiat, pay) {
  return fiat && fiat !== DEFAULT_FIAT ? fiat + ':' + pay : pay;
}

// Unidad corta para los textos (Telegram, push, log del bot).
const UNITS = { VES: 'Bs', USD: '$' };
export function fiatUnit(fiat) {
  return UNITS[fiat || DEFAULT_FIAT] || fiat;
}

// Zona IANA valida o la de defecto. Viene del navegador del usuario; se valida
// porque termina en SQL (AT TIME ZONE) y en Intl.
export function safeTz(tz) {
  if (typeof tz === 'string' && tz && tz.length <= 64) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { /* invalida */ }
  }
  return DEFAULT_TZ;
}

// Fecha/hora de pared en la zona dada (Intl resuelve el horario de verano).
function wall(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz(tz), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return p;
}
export function zonedMinutes(ts, tz) {
  const p = wall(ts, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}
export function zonedDateStr(ts, tz) {
  const p = wall(ts, tz);
  return p.year + '-' + p.month + '-' + p.day;
}
export function zonedHm(ts, tz) {
  const p = wall(ts, tz);
  return p.hour + ':' + p.minute;
}
// Medianoche de hoy (en la zona dada) como timestamp UTC.
export function zonedMidnight(ts, tz) {
  const p = wall(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = asUtc - Math.floor(ts / 1000) * 1000; // ms que la zona va adelantada a UTC
  return Date.UTC(+p.year, +p.month - 1, +p.day) - offset;
}
