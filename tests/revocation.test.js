// "Cerrar sesion en todos los dispositivos" tiene que cerrarla en TODAS partes.
//
// La comprobacion vivia dentro del manejador de /api/auth/me y en ningun otro
// sitio, asi que un token revocado seguia abriendo /api/binance-bot (que es un
// proxy firmado hacia la cuenta de Binance del usuario), /api/p2p-search, los
// pagos y Telegram durante los 90 dias de vida del token.
//
// Dos cosas que probar, y la segunda es la que importa de verdad: que la regla
// sea correcta, y que TODO endpoint autenticado pase por ella. El bug original no
// fue una regla mal escrita, fue una regla escrita en un solo sitio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.JWT_SECRET = 'secreto-de-test';
const { sessionIsRevoked } = await import('../api/_lib/auth.js');

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');

// ── La regla ────────────────────────────────────────────────────────────────

test('sin revocacion, cualquier token vale', () => {
  assert.equal(sessionIsRevoked(1000, 0), false);
  assert.equal(sessionIsRevoked(0, 0), false);
});

test('un token emitido antes del corte queda invalidado', () => {
  assert.equal(sessionIsRevoked(999, 1000), true);
});

test('un token emitido justo en el corte sigue valiendo', () => {
  // El corte es "todo lo ANTERIOR deja de valer": si no, revocar invalidaria
  // tambien la sesion que se acaba de emitir en ese mismo segundo.
  assert.equal(sessionIsRevoked(1000, 1000), false);
  assert.equal(sessionIsRevoked(1001, 1000), false);
});

test('un token sin iat se trata como el mas viejo posible', () => {
  assert.equal(sessionIsRevoked(undefined, 1000), true);
});

test('un usuario borrado pierde todas sus sesiones', () => {
  assert.equal(sessionIsRevoked(Date.now() / 1000 + 9e9, Infinity), true);
});

// ── El cableado ─────────────────────────────────────────────────────────────

function apiFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(API);
  return out;
}

test('todos los endpoints resuelven la identidad por la capa de auth', () => {
  // Saltarse requireUser y verificar el JWT a mano es exactamente como se vuelve
  // a abrir este agujero: la revocacion vive dentro de requireUser.
  const permitidos = [path.join(API, '_lib', 'auth.js'), path.join(API, '_lib', 'crypto.js')];
  const culpables = apiFiles().filter(f =>
    !permitidos.includes(f) && /\bverifyJWT\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(culpables, [], 'estos archivos verifican el JWT por su cuenta');
});

test('ninguna llamada a requireUser se queda sin await', () => {
  // requireUser es async desde que comprueba la revocacion. Sin await devuelve una
  // Promise, que es un objeto "verdadero": la comprobacion se saltaria en silencio
  // y user.uid seria undefined.
  const AUTH = path.join(API, '_lib', 'auth.js');
  const malas = [];
  for (const f of apiFiles()) {
    if (f === AUTH) continue; // aqui viven las definiciones, no las llamadas
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(await\s+)?require(?:Allowed)?User\s*\(/g)) {
      if (!m[1]) malas.push(path.relative(API, f) + ' @ linea ' + src.slice(0, m.index).split('\n').length);
    }
  }
  assert.deepEqual(malas, [], 'estas llamadas necesitan await');

  // Y dentro de la propia capa: requireAllowedUser delega en requireUser.
  assert.match(fs.readFileSync(AUTH, 'utf8'), /const u = await requireUser\(req\)/);
});

test('la revocacion se comprueba en un solo sitio, y ese sitio es requireUser', () => {
  const auth = fs.readFileSync(path.join(API, '_lib', 'auth.js'), 'utf8');
  assert.match(auth, /export async function requireUser/);
  assert.match(auth, /assertNotRevoked\(user\)/, 'requireUser debe comprobarla');

  // Nadie mas debe leer sessions_valid_from para decidir: /api/auth/revoke solo
  // la escribe.
  for (const f of apiFiles()) {
    if (f === path.join(API, '_lib', 'auth.js') || f === path.join(API, '_lib', 'db.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const lee = /SELECT[^`]*sessions_valid_from/i.test(src);
    assert.equal(lee, false, path.relative(API, f) + ' vuelve a comprobarla por su cuenta');
  }
});

test('revocar limpia la cache para que se aplique en el acto', () => {
  const src = fs.readFileSync(path.join(API, 'auth', '[action].js'), 'utf8');
  const revoke = src.slice(src.indexOf('async function revoke'));
  assert.match(revoke.slice(0, 900), /forgetRevocation\(user\.uid\)/);
});
