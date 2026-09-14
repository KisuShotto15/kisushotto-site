import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-para-test';
process.env.JWT_SECRET = 'secreto-de-test';
process.env.AI_SUGGEST_SECRET = 'ks-planner-h5J0RBoYZutr';

const { signJWT } = await import('../api/_lib/crypto.js');
const { default: handler } = await import('../api/claude-suggest.js');

function mkRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
const call = async (headers, body, method = 'POST') => {
  const res = mkRes();
  await handler({ method, headers, body }, res);
  return res;
};
const TOKEN = signJWT({ uid: 7, email: 'ef@x.com' });

test('sin credencial: 401, y no llega a la API de Anthropic', async () => {
  const r = await call({}, { goalTitle: 'Aprender aleman' });
  assert.equal(r.statusCode, 401);
});

test('con un secreto equivocado: 401', async () => {
  const r = await call({ 'x-app-secret': 'adivinado' }, { goalTitle: 'Aprender aleman' });
  assert.equal(r.statusCode, 401);
});

test('con un JWT manipulado: 401', async () => {
  const r = await call({ authorization: 'Bearer ' + TOKEN.slice(0, -3) + 'aaa' }, { goalTitle: 'x' });
  assert.equal(r.statusCode, 401);
});

test('el secreto puente pasa la puerta y llega a la validacion de entrada', async () => {
  const r = await call({ 'x-app-secret': process.env.AI_SUGGEST_SECRET }, { goalTitle: '   ' });
  assert.equal(r.statusCode, 400, 'paso la auth y rechazo el titulo vacio');
  assert.match(r.body.error, /goalTitle/);
});

test('un JWT valido pasa la puerta', async () => {
  const r = await call({ authorization: 'Bearer ' + TOKEN }, { goalTitle: '' });
  assert.equal(r.statusCode, 400);
});

test('el limite por IP corta el bucle anonimo en 10/hora', async () => {
  const headers = { 'x-app-secret': process.env.AI_SUGGEST_SECRET, 'x-forwarded-for': '203.0.113.9' };
  let cortado = 0;
  for (let i = 0; i < 14; i++) {
    const r = await call(headers, { goalTitle: '' }); // 400 = paso la puerta
    if (r.statusCode === 429) cortado++;
  }
  assert.equal(cortado, 4, '10 pasan, las 4 siguientes se cortan');
});

test('cada usuario con JWT tiene su propio cupo de 20/hora', async () => {
  const otro = signJWT({ uid: 99, email: 'otro@x.com' });
  let cortado = 0;
  for (let i = 0; i < 22; i++) {
    const r = await call({ authorization: 'Bearer ' + otro }, { goalTitle: '' });
    if (r.statusCode === 429) cortado++;
  }
  assert.equal(cortado, 2);
  // el cupo del uid 7 sigue intacto: no se cruzan
  const r = await call({ authorization: 'Bearer ' + TOKEN }, { goalTitle: '' });
  assert.equal(r.statusCode, 400);
});

test('sin AI_SUGGEST_SECRET configurada, el acceso anonimo queda cerrado', async () => {
  const guardado = process.env.AI_SUGGEST_SECRET;
  delete process.env.AI_SUGGEST_SECRET;
  const r = await call({ 'x-app-secret': 'lo-que-sea' }, { goalTitle: 'x' });
  process.env.AI_SUGGEST_SECRET = guardado;
  assert.equal(r.statusCode, 401);
});

test('OPTIONS responde el preflight sin credencial', async () => {
  const r = await call({}, null, 'OPTIONS');
  assert.equal(r.statusCode, 204);
  assert.match(r.headers['access-control-allow-headers'], /X-App-Secret/);
});

test('GET no se acepta', async () => {
  const r = await call({ 'x-app-secret': process.env.AI_SUGGEST_SECRET }, null, 'GET');
  assert.equal(r.statusCode, 405);
});
