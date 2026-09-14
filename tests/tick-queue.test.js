// El tick atiende a los usuarios en fila dentro de 60 segundos. Dos cosas lo
// hacen soportable cuando hay mas usuarios de los que caben:
//
//  1. Que la cola sea justa. Sin ORDER BY, Postgres devuelve las filas en el
//     orden que le conviene: los que quedan fuera del LIMIT son siempre los
//     mismos y su bot deja de repreciarse sin ningun error visible.
//  2. Que ninguna llamada externa pueda colgarse sin tope. Todas las de Binance
//     ya lo tenian; sendTelegram era la unica del camino que no, y se llama
//     dentro del tick, con el reloj compartido corriendo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Cola justa ──────────────────────────────────────────────────────────────

const tick = fs.readFileSync(path.join(ROOT, 'api', 'bot-tick.js'), 'utf8');

test('toda consulta que elige a quien atender lleva un orden explicito', () => {
  const lineas = tick.split('\n');
  const sinOrden = [];
  lineas.forEach((l, i) => {
    if (!l.includes('LIMIT ${MAX_USERS}')) return;
    // La linea anterior con contenido tiene que ser el ORDER BY.
    let j = i - 1;
    while (j >= 0 && !lineas[j].trim()) j--;
    if (!/ORDER BY/.test(lineas[j] || '')) sinOrden.push('linea ' + (i + 1));
  });
  assert.deepEqual(sinOrden, [], 'estas consultas dejan el orden al azar');
});

test('el orden es por antiguedad, y quien nunca fue atendido va primero', () => {
  // NULLS FIRST importa: en Postgres, ASC pone los NULL al FINAL por defecto, asi
  // que sin el, un usuario que acaba de encender su bot (last_tick NULL) seria el
  // ultimo de la cola en vez del primero.
  const ordenes = [...tick.matchAll(/ORDER BY\s+(\S+)\s+ASC\s+NULLS FIRST/g)].map(m => m[1]);
  assert.deepEqual(ordenes, ['b.last_tick', 'b.orders_checked_at', 'm.last_tick']);
  assert.equal((tick.match(/ORDER BY/g) || []).length, 3, 'no debe haber otros ORDER BY sueltos');
});

test('el tope por tick sigue acotado: una invocacion no puede crecer sin limite', () => {
  assert.match(tick, /const MAX_USERS = \d+;/);
  const max = Number(tick.match(/const MAX_USERS = (\d+);/)[1]);
  assert.ok(max > 0 && max <= 50, 'MAX_USERS fuera de rango razonable: ' + max);
});

// ── Timeout de Telegram ─────────────────────────────────────────────────────

const { sendTelegram } = await import('../api/_lib/telegram.js');

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test('el envio lleva senal de aborto, para no colgarse dentro del tick', async () => {
  let visto = null;
  globalThis.fetch = async (_url, opts) => { visto = opts; return { ok: true }; };

  const ok = await sendTelegram('tok', '123', 'hola');
  assert.equal(ok, true);
  assert.ok(visto.signal instanceof AbortSignal, 'el fetch necesita un signal');
  assert.equal(visto.signal.aborted, false, 'no puede llegar ya abortado');
});

test('si el envio se aborta o falla, devuelve false y no tumba el tick', async () => {
  globalThis.fetch = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  assert.equal(await sendTelegram('tok', '123', 'hola'), false);
});

test('un rechazo de Telegram (429, 403) tambien devuelve false', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  assert.equal(await sendTelegram('tok', '123', 'hola'), false);
});

test('sin token o sin chat no se llama a la red siquiera', async () => {
  let llamadas = 0;
  globalThis.fetch = async () => { llamadas++; return { ok: true }; };
  assert.equal(await sendTelegram('', '123', 'hola'), false);
  assert.equal(await sendTelegram('tok', '', 'hola'), false);
  assert.equal(llamadas, 0);
});

test('el tope de espera esta puesto y es corto', () => {
  // Un envio normal tarda decimas de segundo. Si alguien sube esto a 30 s, el
  // timeout deja de proteger el presupuesto del tick.
  const src = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'telegram.js'), 'utf8');
  const ms = Number(src.match(/const SEND_TIMEOUT_MS = (\d+);/)[1]);
  assert.ok(ms > 0 && ms <= 10000, 'timeout de Telegram fuera de rango: ' + ms);
  assert.match(src, /signal: AbortSignal\.timeout\(SEND_TIMEOUT_MS\)/);
});
