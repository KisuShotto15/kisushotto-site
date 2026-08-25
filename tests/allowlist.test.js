import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed } from '../api/_lib/allowlist.js';

function conLista(valor, fn) {
  const antes = process.env.ALLOWED_EMAILS;
  if (valor === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = valor;
  try { fn(); } finally {
    if (antes === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = antes;
  }
}

test('sin lista configurada el registro esta abierto', () => {
  conLista(undefined, () => {
    assert.equal(isAllowed('cualquiera@gmail.com'), true);
  });
  conLista('   ', () => {
    assert.equal(isAllowed('cualquiera@gmail.com'), true);
  });
});

test('un asterisco abre el acceso sin borrar la env', () => {
  conLista('*', () => assert.equal(isAllowed('cualquiera@gmail.com'), true));
});

test('con lista concreta solo entra quien esta en ella', () => {
  conLista('due@gmail.com, Otro@Gmail.com', () => {
    assert.equal(isAllowed('due@gmail.com'), true);
    assert.equal(isAllowed('  OTRO@gmail.com '), true);
    assert.equal(isAllowed('intruso@gmail.com'), false);
    assert.equal(isAllowed(''), false);
    assert.equal(isAllowed(null), false);
  });
});
