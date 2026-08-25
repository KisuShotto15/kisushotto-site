// Cliente de Binance Pay (Merchant API). Firma HMAC-SHA512 en las requests salientes
// (con nuestra API key/secret de comerciante); el webhook entrante lo firma Binance con
// su clave privada y lo verificamos con su certificado publico (RSA-SHA256).
// Docs: developers.binance.com/docs/binance-pay
import crypto from 'node:crypto';

const BASE = 'https://bpay.binanceapi.com';

function nonce32() {
  return crypto.randomBytes(16).toString('hex'); // 32 chars
}

function sign(secretKey, timestamp, nonce, bodyStr) {
  const payload = `${timestamp}\n${nonce}\n${bodyStr}\n`;
  return crypto.createHmac('sha512', secretKey).update(payload).digest('hex').toUpperCase();
}

async function call(apiKey, secretKey, path, bodyObj) {
  const timestamp = Date.now();
  const nonce = nonce32();
  const bodyStr = JSON.stringify(bodyObj || {});
  const signature = sign(secretKey, timestamp, nonce, bodyStr);
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BinancePay-Timestamp': String(timestamp),
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': apiKey,
      'BinancePay-Signature': signature,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data.status === 'SUCCESS', data };
}

// Crea una orden de cobro. amount en string/number, ej. "5.00".
export async function createOrder(apiKey, secretKey, { merchantTradeNo, amount, currency, goodsName, goodsDetail }) {
  const body = {
    env: { terminalType: 'WEB' },
    merchantTradeNo,
    orderAmount: String(amount),
    currency: currency || 'USDT',
    goods: {
      goodsType: '02', // 02 = bien/servicio virtual
      goodsCategory: 'Z000', // otros
      referenceGoodsId: 'sub-monthly',
      goodsName: goodsName || 'Suscripcion mensual',
      goodsDetail: goodsDetail || '',
    },
  };
  return call(apiKey, secretKey, '/binancepay/openapi/v3/order', body);
}

// Link de cobro de cuenta PERSONAL (Agent Pay): no necesita cuenta Merchant, las
// claves salen de la app de Binance (Perfil > API Management, permiso de pagos).
// Devuelve shareLink + qrImageUrl. No tiene merchantTradeNo ni webhook: sirve para
// generar el link con monto y nota exactos, pero la confirmacion sigue siendo manual.
export async function createReceiveLink(apiKey, secretKey, { amount, currency, description }) {
  const body = { currency: currency || 'USDT', amount: String(amount) };
  if (description) body.description = description;
  return call(apiKey, secretKey, '/binancepay/openapi/user/c2c/createReceive', body);
}

export async function queryOrder(apiKey, secretKey, merchantTradeNo) {
  return call(apiKey, secretKey, '/binancepay/openapi/v2/order/query', { merchantTradeNo });
}

// Certificado publico de Binance para verificar la firma de los webhooks entrantes.
// Se cachea en memoria (vive mientras la instancia serverless este caliente): no rota seguido.
let certCache = null;
let certCacheAt = 0;
const CERT_TTL_MS = 6 * 3600 * 1000;

async function getCert(apiKey, secretKey) {
  if (certCache && Date.now() - certCacheAt < CERT_TTL_MS) return certCache;
  const { ok, data } = await call(apiKey, secretKey, '/binancepay/openapi/certificates', {});
  if (!ok || !Array.isArray(data.data) || !data.data.length) throw new Error('No se pudo obtener el certificado de Binance Pay');
  certCache = data.data; // [{certSerial, certPublic}, ...]
  certCacheAt = Date.now();
  return certCache;
}

function toPem(rawPublicKey) {
  const body = rawPublicKey.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

// headers: req.headers de Vercel (ya en minuscula). rawBody: string exacto recibido (sin re-serializar).
export async function verifyWebhookSignature(headers, rawBody, apiKey, secretKey) {
  const timestamp = headers['binancepay-timestamp'];
  const nonceH = headers['binancepay-nonce'];
  const signature = headers['binancepay-signature'];
  const certSN = headers['binancepay-certificate-sn'];
  if (!timestamp || !nonceH || !signature || !certSN) return false;

  const certs = await getCert(apiKey, secretKey);
  const cert = certs.find(c => c.certSerial === certSN) || certs[0];
  if (!cert) return false;

  const payload = `${timestamp}\n${nonceH}\n${rawBody}\n`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(payload);
  verifier.end();
  try {
    return verifier.verify(toPem(cert.certPublic), signature, 'base64');
  } catch (e) {
    return false;
  }
}
