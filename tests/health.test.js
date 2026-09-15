// El panel de salud: saber si los bots de los clientes se estan repreciando.
//
// Hasta ahora no habia forma de saberlo. El tick no dejaba rastro: si se quedaba
// sin tiempo a mitad de la lista, a los que faltaban no se les repreciaba y NO
// pasaba nada visible — ni error, ni log, ni aviso. El primero en enterarse era
// el cliente, escribiendo para preguntar por que su anuncio no se mueve.
//
// Lo que se prueba aqui es el veredicto (cuando decir que algo va mal) y el
// cableado: que lo que el panel mide sea lo mismo que el tick hace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { healthProblems, TICK_STALE_S, BOT_STALE_MIN } = await import('../api/_lib/health.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Un sistema sano: tick reciente, sin huecos, sin bots colgados.
const SANO = { last_age_s: 12, max_gap_s: 31, capped: 0, errors: 0, runs: 118 };

// ── El veredicto ────────────────────────────────────────────────────────────

test('con todo en orden no se inventa ningun problema', () => {
  assert.deepEqual(healthProblems(SANO, { eligible: 3, recent: 3, stale: 0, failing: 0 }), []);
});

test('un tick que dejo de aparecer es lo primero que se dice', () => {
  const p = healthProblems({ ...SANO, last_age_s: 600 }, {});
  assert.equal(p.length, 1);
  assert.match(p[0], /600 s sin aparecer/);
  assert.match(p[0], /no se está repreciando nadie/, 'la consecuencia, no solo el dato');
});

test('el umbral no salta por una invocacion lenta', () => {
  assert.deepEqual(healthProblems({ ...SANO, last_age_s: TICK_STALE_S }, {}), []);
  assert.equal(healthProblems({ ...SANO, last_age_s: TICK_STALE_S + 1 }, {}).length, 1);
});

test('sin ninguna ejecucion registrada se dice, no se da por bueno', () => {
  // El caso peligroso: cero filas podria leerse como "cero problemas".
  const p = healthProblems({ last_age_s: null }, {});
  assert.equal(p.length, 1);
  assert.match(p[0], /nunca/);
});

test('un hueco entre ticks se reporta aunque el ultimo sea reciente', () => {
  // El scheduler se cayo media hora y volvio: mirando solo "hace cuanto fue el
  // ultimo" no se veria nada.
  const p = healthProblems({ ...SANO, max_gap_s: 1800 }, {});
  assert.equal(p.length, 1);
  assert.match(p[0], /hueco de 1800 s/);
});

test('bots sin reprecio y bots en error son problemas distintos', () => {
  const p = healthProblems(SANO, { stale: 2, failing: 1 });
  assert.equal(p.length, 2);
  assert.match(p[0], /2 bots llevan más de 5 min sin reprecio/);
  assert.match(p[1], /1 bot está en error/);
});

test('el tope de usuarios avisa antes de que a alguien se le pare el bot', () => {
  const p = healthProblems({ ...SANO, capped: 4 }, {});
  assert.equal(p.length, 1);
  assert.match(p[0], /tope de usuarios 4 veces/);
  assert.match(p[0], /puede haber gente esperando/);
});

test('varios problemas a la vez se acumulan, no se pisan', () => {
  const p = healthProblems({ last_age_s: 300, max_gap_s: 400, capped: 1 }, { stale: 5, failing: 2 });
  assert.equal(p.length, 5);
});

test('un objeto vacio no revienta', () => {
  assert.equal(healthProblems().length, 1, 'solo el "nunca ha corrido"');
});

// ── El cableado ─────────────────────────────────────────────────────────────

test('el tick deja constancia de cada ejecucion', () => {
  const src = read('api/bot-tick.js');
  assert.match(src, /INSERT INTO tick_runs/, 'sin esto no hay nada que medir');
  // En el return normal Y en el catch: un tick que revienta entero es justo el
  // que hay que poder ver despues.
  assert.equal((src.match(/await recordRun\(/g) || []).length, 2);
});

test('registrar la metrica no puede tumbar el tick', () => {
  const src = read('api/bot-tick.js');
  const fn = src.slice(src.indexOf('async function recordRun'));
  const cuerpo = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.match(cuerpo, /try \{/, 'todo el cuerpo va dentro de un try');
  assert.match(cuerpo, /catch/, 'y el fallo se traga: la salud no vale un reprecio');
});

test('la limpieza de la tabla no corre en cada tick', () => {
  // Con la conexion a max: 1 las consultas se encolan: barrer ~2900 filas cada
  // 30 s seria pagar latencia del tick por nada.
  const src = read('api/bot-tick.js');
  const del = src.slice(src.indexOf('DELETE FROM tick_runs') - 200, src.indexOf('DELETE FROM tick_runs'));
  assert.match(del, /Math\.random\(\)/);
});

test('el panel mide a los mismos usuarios que el tick atiende', () => {
  // Si los dos criterios de elegibilidad se separan, el panel miente justo sobre
  // lo que dice medir: contaria bots que el tick nunca toca, o al reves.
  const tick = read('api/bot-tick.js');
  const panel = read('api/binance-bot.js');
  const crit = /s\.status = 'trialing' AND s\.trial_end > now\(\)/;
  assert.match(tick, crit);
  assert.match(panel, crit);
  for (const src of [tick, panel]) {
    assert.match(src, /s\.status = 'active' AND s\.current_period_end > \$\{graceFrom\}/);
  }
});

test('el panel es solo para el dueño', () => {
  const src = read('api/binance-bot.js');
  const i = src.indexOf("path === '/admin-health'");
  assert.ok(i > 0, 'el endpoint existe');
  const bloque = src.slice(i, i + 400);
  assert.match(bloque, /ADMIN_EMAIL/);
  assert.match(bloque, /403/, 'quien no sea el dueño no ve la salud de los demás');
});

test('el panel asegura su tabla: no depende de que el tick haya corrido aqui', () => {
  const src = read('api/binance-bot.js');
  const i = src.indexOf("path === '/admin-health'");
  assert.match(src.slice(i, i + 600), /await ensureTickRuns\(\)/);
});

test('el veredicto se calcula en el servidor, no en el cliente', () => {
  // Si el punto rojo del botón y el detalle del panel pudieran discrepar, el
  // panel dejaría de servir para lo único que sirve.
  const cli = read('public/p2p-monitor/main.js');
  assert.match(cli, /d\.ok \? 'none' : ''/, 'el cliente solo pinta el veredicto');
  assert.doesNotMatch(cli, new RegExp('last_age_s\\s*>\\s*' + TICK_STALE_S),
    'el umbral no puede estar duplicado a mano en el cliente');
});

test('los umbrales viven en un solo sitio', () => {
  assert.equal(TICK_STALE_S, 90);
  assert.equal(BOT_STALE_MIN, 5);
  const panel = read('api/binance-bot.js');
  assert.match(panel, /import \{ healthProblems, TICK_STALE_S, BOT_STALE_MIN \}/);
  assert.doesNotMatch(panel, /const TICK_STALE_S =/, 'no redefinido al lado');
});

// ── El escenario completo ───────────────────────────────────────────────────
// Los numeros de abajo no estan inventados: salen de correr las consultas del
// endpoint contra un Postgres 16 real con datos sembrados (40 ticks cada 30 s con
// un corte de 10 min en medio, tres bots encendidos de los cuales uno tiene la
// suscripcion vencida, uno en error y uno al dia). Aqui se fija que, con esas
// cifras, el veredicto diga lo que tiene que decir.
test('un dia malo se describe entero, no a medias', () => {
  const p = healthProblems(
    { runs: 40, avg_ms: 1220, max_ms: 1239, errors: 2, capped: 1, max_gap_s: 630, last_age_s: 0 },
    { eligible: 2, recent: 1, stale: 1, failing: 1 });

  assert.equal(p.length, 4);
  assert.ok(p.some(x => /hueco de 630 s/.test(x)), 'el scheduler se cayo 10 min y volvio');
  assert.ok(p.some(x => /1 bot lleva más de 5 min sin reprecio/.test(x)));
  assert.ok(p.some(x => /1 bot está en error/.test(x)));
  assert.ok(p.some(x => /tope de usuarios 1 vez/.test(x)));
  // El ultimo tick fue hace 0 s: mirando solo eso, todo pareceria correcto.
  assert.ok(!p.some(x => /sin aparecer/.test(x)));
});
