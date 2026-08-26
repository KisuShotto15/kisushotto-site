import test from 'node:test';
import assert from 'node:assert/strict';
import { renewalMessage } from '../api/_lib/renewals.js';
import { GRACE_MS } from '../api/_lib/subscriptions.js';

const DAY = 24 * 3600 * 1000;
const URL = 'https://kisushotto.com/p2p-monitor/';

test('avisa los dias que faltan y singulariza el ultimo', () => {
  assert.match(renewalMessage('active', 3 * DAY, URL).title, /vence en 3 dias/);
  assert.match(renewalMessage('active', 0.5 * DAY, URL).title, /vence en 1 dia$/);
});

test('vencida pero dentro de la cortesia: dice que todo sigue andando', () => {
  const m = renewalMessage('active', -GRACE_MS / 2, URL);
  assert.match(m.title, /vencio/);
  assert.match(m.tg, /cortesia/);
  assert.match(m.tg, /1 dia/);
});

test('agotada la cortesia: acceso suspendido', () => {
  const m = renewalMessage('active', -GRACE_MS - 1000, URL);
  assert.match(m.title, /suspendido/);
  assert.match(m.tg, /pausa/);
});

test('la prueba no tiene cortesia: al vencer queda en pausa', () => {
  assert.match(renewalMessage('trialing', 2 * DAY, URL).title, /prueba termina en 2 dias/);
  const fin = renewalMessage('trialing', -1000, URL);
  assert.match(fin.title, /Se acabo tu prueba/);
  assert.doesNotMatch(fin.tg, /cortesia/);
});

test('todos los avisos llevan el enlace a la app', () => {
  for (const ms of [3 * DAY, -GRACE_MS / 2, -GRACE_MS - 1000]) {
    assert.ok(renewalMessage('active', ms, URL).tg.includes(URL));
    assert.ok(renewalMessage('trialing', ms, URL).tg.includes(URL));
  }
});
