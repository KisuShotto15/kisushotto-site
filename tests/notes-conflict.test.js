// Dos dispositivos editando la misma nota.
//
// El cliente ya mandaba `base_lm` (el last_modified que tenia cuando empezo a
// editar) pero el servidor lo ignoraba: el ultimo push ganaba siempre y lo
// escrito en el otro dispositivo desaparecia sin aviso. Aqui se fija que el
// servidor rechace ese push, y que lo haga SOLO cuando hay un choque real —
// un intento anterior de detectar conflictos generaba copias falsas por cada
// vez que el propio servidor movia la marca por su cuenta.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'secreto-de-test';
const { signJWT } = await import('../api/_lib/crypto.js');

globalThis.caches = {
  default: { async match() { return undefined; }, async put() {} },
};
globalThis.fetch = async () => new Response('{}', { status: 200 });

const notes = (await import('../workers/notes-worker/src/index.js')).default;

const YO = 'ef@x.com';
const env = {
  JWT_SECRET: process.env.JWT_SECRET,
  ALLOWED_EMAILS: YO,
  DB: null,
  PUSH_KV: { async get() { return null; }, async put() {} },
};

// D1 de mentira con una tabla `notes` de verdad: lo que se prueba es el efecto
// de un push sobre lo guardado, asi que las filas tienen que existir.
const tabla = new Map();
function makeDB() {
  const stmt = sql => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async first() {
      if (/FROM notes WHERE id/.test(sql)) return tabla.get(this.args[0]) || null;
      if (/FROM users WHERE email/.test(sql)) return { email: YO };
      return null;                                   // note_shares, etc.
    },
    async all() {
      if (/SELECT \* FROM notes WHERE owner_email/.test(sql)) {
        const [email, since] = this.args;
        return { results: [...tabla.values()]
          .filter(n => n.owner_email === email && n.last_modified >= since) };
      }
      return { results: [] };
    },
    async run() {
      if (/^UPDATE notes SET title=/.test(sql)) {
        const id = this.args[this.args.length - 1];
        const row = tabla.get(id);
        if (row) { row.title = this.args[0]; row.body = this.args[1]; row.last_modified = this.args[11]; }
      } else if (/^INSERT INTO notes /.test(sql)) {
        const [id, owner_email, title, body] = this.args;
        tabla.set(id, { id, owner_email, title, body, last_modified: this.args[13], created_at: this.args[14] });
      }
      return { meta: { changes: 1 } };
    },
  });
  return {
    prepare: stmt,
    async batch(stmts) { for (const s of stmts) await s.run(); return []; },
  };
}
env.DB = makeDB();

const auth = { Authorization: 'Bearer ' + signJWT({ uid: 1, email: YO }), 'Content-Type': 'application/json' };
const push = notas => notes.fetch(new Request('https://w.dev/sync', {
  method: 'POST', headers: auth, body: JSON.stringify({ notes: notas, since: 0 }),
}), env);

// Deja una nota guardada y devuelve el last_modified que le puso el servidor.
async function sembrar(id, title) {
  tabla.delete(id);
  const r = await push([{ id, title, body: '' }]);
  return (await r.json()).results.notes[id].last_modified;
}

test('el servidor devuelve la marca que asigno, para que el cliente la use de base', async () => {
  const lm = await sembrar('n1', 'original');
  assert.ok(lm > 0);
  assert.equal(tabla.get('n1').last_modified, lm);
});

test('editar desde la base correcta pasa', async () => {
  const lm = await sembrar('n2', 'original');
  const r = await push([{ id: 'n2', title: 'editada', body: '', base_lm: lm }]);
  const res = (await r.json()).results.notes.n2;
  assert.equal(res.skipped, false);
  assert.equal(tabla.get('n2').title, 'editada');
});

test('editar desde una base vieja se rechaza y NO pisa lo guardado', async () => {
  const lm = await sembrar('n3', 'original');

  // El otro dispositivo escribe primero.
  await push([{ id: 'n3', title: 'del otro', body: '', base_lm: lm }]);
  const lmOtro = tabla.get('n3').last_modified;

  // Este dispositivo sigue creyendo que la nota esta en `lm`.
  const r = await push([{ id: 'n3', title: 'la mia', body: '', base_lm: lm }]);
  const res = (await r.json()).results.notes.n3;

  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'conflict');
  assert.equal(res.last_modified, lmOtro, 'se dice contra que version choco');
  assert.equal(tabla.get('n3').title, 'del otro', 'lo del otro dispositivo sigue ahi');
});

test('un cliente sin base_lm sigue guardando: no se le deja fuera', async () => {
  const lm = await sembrar('n4', 'original');
  await push([{ id: 'n4', title: 'del otro', body: '', base_lm: lm }]);

  const r = await push([{ id: 'n4', title: 'sin base', body: '' }]);
  assert.equal((await r.json()).results.notes.n4.skipped, false);
  assert.equal(tabla.get('n4').title, 'sin base');
});

test('PATCH /notes/:id responde 409, no un falso ok', async () => {
  const lm = await sembrar('n5', 'original');
  await push([{ id: 'n5', title: 'del otro', body: '', base_lm: lm }]);

  const r = await notes.fetch(new Request('https://w.dev/notes/n5', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'la mia', base_lm: lm }),
  }), env);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'conflict');
});

test('POST /notes devuelve la marca asignada', async () => {
  const r = await notes.fetch(new Request('https://w.dev/notes', {
    method: 'POST', headers: auth, body: JSON.stringify({ id: 'n6', title: 'nueva' }),
  }), env);
  assert.equal(r.status, 201);
  assert.ok((await r.json()).note_last_modified > 0, 'sin esto el cliente no tiene base');
});

test('mover a la papelera devuelve la marca nueva', async () => {
  await sembrar('n7', 'original');
  const r = await notes.fetch(new Request('https://w.dev/notes/n7', { method: 'DELETE', headers: auth }), env);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.ok(b.note_last_modified > 0, 'si no, el proximo push chocaria contra el propio borrado');
});

// ── La fuente de los conflictos falsos ──────────────────────────────────────

test('borrar una categoria no mueve la marca de las notas que la usaban', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../workers/notes-worker/src/index.js', import.meta.url), 'utf8');
  const cuerpo = src.slice(src.indexOf('async function deleteCategory'));
  const fin = cuerpo.indexOf('\nasync function', 1);
  const fn = cuerpo.slice(0, fin === -1 ? cuerpo.length : fin);
  assert.doesNotMatch(fn, /UPDATE notes SET last_modified/,
    'esto movia la marca de decenas de notas que nadie habia tocado, y cada una ' +
    'de ellas se convertia en un conflicto falso en el siguiente push');
});

// ── La mitad del cliente: que hacer con lo que el servidor rechazo ──────────

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {}, readyState: 'complete' };

const { conflictCopy } = await import('../notes/sync.js');

const NOTA = (extra = {}) => ({
  id: 'x', title: 'lista', body: 'a', type: 'text', checklist_items: [],
  color: null, pinned: false, archived: false, trashed_at: null,
  locked: false, reminder_at: null, last_modified: 100, ...extra,
});

test('si las dos versiones dicen lo mismo, no se crea ninguna copia', () => {
  // Este es el caso que importa: el servidor mueve last_modified por su cuenta
  // (adjuntar una imagen, mover a la papelera) sin que el contenido cambie. Si
  // eso generara una copia, la app se llenaria de duplicados igual que antes.
  assert.equal(conflictCopy(NOTA(), NOTA({ last_modified: 999 })), null);
});

test('si el contenido difiere de verdad, lo escrito aqui se conserva aparte', () => {
  const mio = NOTA({ body: 'lo que escribi yo' });
  const copia = conflictCopy(mio, NOTA({ body: 'lo que escribio el otro' }));

  assert.equal(copia.body, 'lo que escribi yo', 'no se pierde');
  assert.notEqual(copia.id, mio.id, 'es una nota nueva, no pisa la del servidor');
  assert.match(copia.title, /versión de este dispositivo/, 'se ve de donde salio');
  assert.equal(copia.base_lm, null, 'nota nueva: nada contra lo que chocar');
});

test('la copia no arrastra los adjuntos ni los compartidos de la original', () => {
  const copia = conflictCopy(
    NOTA({ body: 'mio', attachments: [{ id: 'a1' }], shares: [{ email: 'otro@x.com' }] }),
    NOTA({ body: 'suyo' }));
  assert.deepEqual(copia.attachments, [], 'los ficheros siguen colgando de la original');
  assert.deepEqual(copia.shares, [], 'no se comparte con nadie sin querer');
});

test('cada campo visible cuenta como diferencia', () => {
  for (const [k, v] of Object.entries({
    title: 'otro', body: 'otro', pinned: true, archived: true,
    color: '#f00', trashed_at: 5, locked: true, reminder_at: 7,
  })) {
    assert.ok(conflictCopy(NOTA({ [k]: v }), NOTA()), k + ' deberia contar como cambio');
  }
  assert.ok(conflictCopy(NOTA({ checklist_items: [{ t: 'leche' }] }), NOTA()));
});

test('sin version del servidor no se inventa nada', () => {
  assert.equal(conflictCopy(NOTA(), null), null);
  assert.equal(conflictCopy(null, NOTA()), null);
});

test('la copia no lleva el sufijo del bug anterior, que la app borra al arrancar', () => {
  const copia = conflictCopy(NOTA({ body: 'mio' }), NOTA({ body: 'suyo' }));
  assert.doesNotMatch(copia.title, /\(copia de conflicto\)$/,
    'notes/main.js borra esas al cargar: la copia nueva desapareceria sola');
});
