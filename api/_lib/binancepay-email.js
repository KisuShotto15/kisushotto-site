// Parser de los correos "[Binance] Payment Receive Successful" (do-not-reply@ses.binance.com).
// Es la confirmacion de un pago ENTRANTE al Payment Link (cuenta personal, sin Merchant API).
// El cuerpo real (texto plano derivado de una tabla HTML) trae la fila de datos como:
//   "2025-12-13 17:28:33(UTC) Emily_Sanchez16 41.41 USDT"
// en ese orden: fecha-hora UTC, nick de Binance del pagador, monto, moneda.
// "Payment Transaction Detail" es el correo de un pago SALIENTE (vos pagando) — se ignora aca.

const SUBJECT_RE = /Payment Receive Successful/i;
const ROW_RE = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*\(UTC\)\s+(\S+)\s+([\d.]+)\s+([A-Za-z]{2,10})/;

// { subject, text } -> { atUtc: Date, senderNick, amount: number, currency } | null
export function parsePaymentReceivedEmail({ subject, text }) {
  if (!SUBJECT_RE.test(String(subject || ''))) return null;
  const m = ROW_RE.exec(String(text || ''));
  if (!m) return null;
  const [, dateStr, senderNick, amountStr, currency] = m;
  const atUtc = new Date(dateStr.replace(' ', 'T') + 'Z');
  if (isNaN(atUtc.getTime())) return null;
  return { atUtc, senderNick, amount: parseFloat(amountStr), currency: currency.toUpperCase() };
}
