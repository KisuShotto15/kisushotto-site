// Cifrado de credenciales en reposo (workers).
//
// Las claves de Bybit del diario de trading estaban en texto plano en D1, mientras
// las de Binance llevaban desde el principio cifradas en Postgres. Cualquiera con
// acceso de lectura a esa base se llevaba credenciales operativas del exchange.
//
// Lo que hay que fijar: que lo cifrado vuelva igual, que sin la clave correcta no
// vuelva nada, y que una fila anterior al cifrado se siga pudiendo usar mientras se
// migra — si no, el sync se cae el dia del despliegue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, isEncrypted } from '../workers/_shared/secret-box.js';

const env = { CRED_ENC_KEY: 'a'.repeat(64) };
const otro = { CRED_ENC_KEY: 'b'.repeat(64) };
const CLAVE = 'BybitApiKey_7fK2mQ';

test('lo cifrado vuelve exactamente igual', async () => {
  const c = await encryptSecret(env, CLAVE);
  assert.equal(await decryptSecret(env, c), CLAVE);
});

test('el texto cifrado no contiene el original', async () => {
  const c = await encryptSecret(env, CLAVE);
  assert.ok(!c.includes(CLAVE), 'no puede verse la clave en lo guardado');
  assert.ok(isEncrypted(c));
});

test('cifrar dos veces lo mismo da resultados distintos', async () => {
  // El IV es aleatorio: sin eso, dos credenciales iguales serian reconocibles como
  // iguales con solo mirar la base.
  const a = await encryptSecret(env, CLAVE);
  const b = await encryptSecret(env, CLAVE);
  assert.notEqual(a, b);
  assert.equal(await decryptSecret(env, a), await decryptSecret(env, b));
});

test('con otra clave maestra no se puede descifrar', async () => {
  const c = await encryptSecret(env, CLAVE);
  await assert.rejects(() => decryptSecret(otro, c));
});

test('un ciphertext manipulado se rechaza, no devuelve basura', async () => {
  // AES-GCM lleva autenticacion: alterar un byte invalida el mensaje entero.
  const c = await encryptSecret(env, CLAVE);
  const roto = c.slice(0, -4) + (c.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(() => decryptSecret(env, roto));
});

test('sin clave maestra valida no se cifra nada', async () => {
  for (const malo of [{}, { CRED_ENC_KEY: '' }, { CRED_ENC_KEY: 'corta' }, { CRED_ENC_KEY: 'z'.repeat(64) }]) {
    await assert.rejects(() => encryptSecret(malo, CLAVE), /CRED_ENC_KEY/);
  }
});

// ── Migracion de lo que quedo en claro ──────────────────────────────────────

test('una credencial vieja en claro se reconoce y se devuelve tal cual', async () => {
  // Es lo que evita que el sync se caiga el dia del despliegue: la fila existente
  // sigue sirviendo hasta que se re-guarda cifrada.
  assert.equal(isEncrypted(CLAVE), false);
  assert.equal(await decryptSecret(env, CLAVE), CLAVE);
});

test('una clave de Bybit real nunca se confunde con algo ya cifrado', async () => {
  for (const k of ['XXQWERTY123', 'v1abc', 'V1:mayusculas', '', null, undefined]) {
    assert.equal(isEncrypted(k), false, String(k));
  }
});

test('el ciclo completo de migracion deja la credencial utilizable', async () => {
  let guardado = CLAVE;                                  // fila vieja, en claro
  const leida = await decryptSecret(env, guardado);
  assert.equal(leida, CLAVE, 'se puede usar antes de migrar');
  if (!isEncrypted(guardado)) guardado = await encryptSecret(env, leida);
  assert.ok(isEncrypted(guardado), 'queda cifrada');
  assert.equal(await decryptSecret(env, guardado), CLAVE, 'y sigue sirviendo');
});

test('soporta credenciales con caracteres no ASCII', async () => {
  const raro = 'clave-áéíóú-ñ-🔑-fin';
  assert.equal(await decryptSecret(env, await encryptSecret(env, raro)), raro);
});
