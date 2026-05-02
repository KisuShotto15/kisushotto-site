// notes-worker — Cloudflare Worker + D1 + R2 + Web Push (VAPID)
// Routes are listed at the bottom in fetch(); cron trigger handles reminders + trash purge.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-User-Email',
  'Access-Control-Expose-Headers': 'Content-Type',
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
const err = (msg, status = 400) => json({ error: msg }, status);
const uuid = () => crypto.randomUUID();
const now = () => Date.now();

function authToken(request, env) {
  const h = request.headers.get('Authorization') || '';
  return h === `Bearer ${env.TOKEN}`;
}
function getUser(request) {
  return (request.headers.get('X-User-Email') || '').toLowerCase().trim() || null;
}

// ── DB bootstrap (idempotent) ────────────────────────────────────────────────
async function migrate(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      display_name TEXT,
      pin_hash TEXT,
      pin_salt TEXT,
      webauthn_credential_id TEXT,
      webauthn_public_key TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cat_owner ON categories(owner_email)`,
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL,
      title TEXT,
      body TEXT,
      type TEXT NOT NULL,
      checklist_items TEXT,
      color TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      locked INTEGER NOT NULL DEFAULT 0,
      reminder_at INTEGER,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      last_modified INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_email)`,
    `CREATE INDEX IF NOT EXISTS idx_notes_lm ON notes(last_modified)`,
    `CREATE TABLE IF NOT EXISTS note_categories (
      note_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (note_id, category_id)
    )`,
    `CREATE TABLE IF NOT EXISTS note_shares (
      note_id TEXT NOT NULL,
      shared_with_email TEXT NOT NULL,
      can_edit INTEGER NOT NULL DEFAULT 1,
      shared_at INTEGER NOT NULL,
      PRIMARY KEY (note_id, shared_with_email)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_shares_with ON note_shares(shared_with_email)`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      type TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      mime TEXT,
      size INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_att_note ON attachments(note_id)`,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  // Additive migrations (ignore error if column already exists)
  try { await env.DB.prepare(`ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`).run(); } catch {}
}

// ── Auth helpers (PIN + WebAuthn) ────────────────────────────────────────────
async function pbkdf2(password, saltB64, iters = 100000) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
function randomSalt() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

// ── Users ────────────────────────────────────────────────────────────────────
async function ensureUser(env, email) {
  const existing = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
  if (existing) return existing;
  const created = now();
  await env.DB.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).bind(email, created).run();
  return { email, display_name: null, pin_hash: null, pin_salt: null, webauthn_credential_id: null, webauthn_public_key: null, created_at: created };
}

async function getMe(env, email) {
  const u = await ensureUser(env, email);
  return json({
    email: u.email,
    display_name: u.display_name,
    has_pin: !!u.pin_hash,
    has_webauthn: !!u.webauthn_credential_id,
    created_at: u.created_at,
  });
}

async function setPin(request, env, email) {
  const { pin } = await request.json();
  if (!pin || !/^\d{4,8}$/.test(String(pin))) return err('PIN debe ser 4-8 dígitos');
  const salt = randomSalt();
  const hash = await pbkdf2(String(pin), salt);
  await env.DB.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ? WHERE email = ?`)
    .bind(hash, salt, email).run();
  return json({ ok: true });
}

async function verifyPin(request, env, email) {
  const { pin } = await request.json();
  const u = await env.DB.prepare(`SELECT pin_hash, pin_salt FROM users WHERE email = ?`).bind(email).first();
  if (!u || !u.pin_hash) return json({ valid: false, reason: 'no-pin' });
  const hash = await pbkdf2(String(pin), u.pin_salt);
  return json({ valid: hash === u.pin_hash });
}

async function registerWebauthn(request, env, email) {
  const { credentialId, publicKey } = await request.json();
  if (!credentialId) return err('credentialId required');
  await env.DB.prepare(`UPDATE users SET webauthn_credential_id = ?, webauthn_public_key = ? WHERE email = ?`)
    .bind(credentialId, publicKey || null, email).run();
  return json({ ok: true });
}

async function getWebauthnInfo(env, email) {
  const u = await env.DB.prepare(`SELECT webauthn_credential_id FROM users WHERE email = ?`).bind(email).first();
  return json({ credentialId: u?.webauthn_credential_id || null });
}

// ── Push subscriptions ──────────────────────────────────────────────────────
async function setPushSubscription(request, env, email) {
  const sub = await request.json();
  if (!sub?.endpoint) return err('subscription required');
  await env.PUSH_KV.put(`push:${email}`, JSON.stringify(sub));
  return json({ ok: true });
}

async function getVapidPublic(env) {
  return json({ key: env.VAPID_PUBLIC || null });
}

// ── Notes ────────────────────────────────────────────────────────────────────
function rowToNote(r, categories = []) {
  return {
    id: r.id,
    owner_email: r.owner_email,
    title: r.title,
    body: r.body,
    type: r.type,
    checklist_items: r.checklist_items ? JSON.parse(r.checklist_items) : [],
    color: r.color,
    pinned: !!r.pinned,
    archived: !!r.archived,
    trashed_at: r.trashed_at,
    locked: !!r.locked,
    reminder_at: r.reminder_at,
    reminder_sent: !!r.reminder_sent,
    last_modified: r.last_modified,
    created_at: r.created_at,
    categories,
  };
}

async function fetchNotesForUser(env, email, since = 0) {
  const ownRes = await env.DB.prepare(
    `SELECT * FROM notes WHERE owner_email = ? AND last_modified >= ? ORDER BY last_modified DESC`
  ).bind(email, since).all();
  const sharedRes = await env.DB.prepare(
    `SELECT n.* FROM notes n
     JOIN note_shares s ON s.note_id = n.id
     WHERE s.shared_with_email = ? AND (n.last_modified >= ? OR s.shared_at >= ?)
     ORDER BY n.last_modified DESC`
  ).bind(email, since, since).all();

  const all = [...(ownRes.results || []), ...(sharedRes.results || [])];
  if (!all.length) return [];

  const ids = all.map(n => n.id);
  const placeholders = ids.map(() => '?').join(',');
  const ncRes = await env.DB.prepare(
    `SELECT note_id, category_id FROM note_categories WHERE note_id IN (${placeholders})`
  ).bind(...ids).all();
  const catMap = {};
  for (const row of ncRes.results || []) {
    (catMap[row.note_id] ||= []).push(row.category_id);
  }

  const sharesRes = await env.DB.prepare(
    `SELECT note_id, shared_with_email, can_edit FROM note_shares WHERE note_id IN (${placeholders})`
  ).bind(...ids).all();
  const shareMap = {};
  for (const row of sharesRes.results || []) {
    (shareMap[row.note_id] ||= []).push({ email: row.shared_with_email, can_edit: !!row.can_edit });
  }

  const attRes = await env.DB.prepare(
    `SELECT id, note_id, type, mime, size, created_at FROM attachments WHERE note_id IN (${placeholders})`
  ).bind(...ids).all();
  const attMap = {};
  for (const row of attRes.results || []) {
    (attMap[row.note_id] ||= []).push(row);
  }

  return all.map(n => ({
    ...rowToNote(n, catMap[n.id] || []),
    shares: shareMap[n.id] || [],
    attachments: attMap[n.id] || [],
  }));
}

async function syncPull(request, env, email) {
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  await ensureUser(env, email);
  const notes = await fetchNotesForUser(env, email, since);
  // Always return ALL categories — deletes are only visible via absence
  const catRes = await env.DB.prepare(
    `SELECT * FROM categories WHERE owner_email = ? ORDER BY sort_order ASC, created_at ASC`
  ).bind(email).all();
  return json({
    notes,
    categories: catRes.results || [],
    server_time: now(),
  });
}

async function canEdit(env, noteId, email) {
  const row = await env.DB.prepare(
    `SELECT owner_email FROM notes WHERE id = ?`
  ).bind(noteId).first();
  if (!row) return false;
  if (row.owner_email === email) return true;
  const share = await env.DB.prepare(
    `SELECT can_edit FROM note_shares WHERE note_id = ? AND shared_with_email = ?`
  ).bind(noteId, email).first();
  return !!(share && share.can_edit);
}

async function upsertNote(env, email, n) {
  const existing = await env.DB.prepare(`SELECT last_modified, owner_email FROM notes WHERE id = ?`).bind(n.id).first();

  const serverNow = now();
  if (existing) {
    if (existing.last_modified > (n.last_modified || 0)) {
      return { skipped: true, reason: 'older' };
    }
    if (!(await canEdit(env, n.id, email))) {
      return { skipped: true, reason: 'forbidden' };
    }
    await env.DB.prepare(
      `UPDATE notes SET title=?, body=?, type=?, checklist_items=?, color=?, pinned=?, archived=?, trashed_at=?, locked=?, reminder_at=?, reminder_sent=?, last_modified=? WHERE id=?`
    ).bind(
      n.title || null,
      n.body || null,
      n.type || 'text',
      n.checklist_items ? JSON.stringify(n.checklist_items) : null,
      n.color || null,
      n.pinned ? 1 : 0,
      n.archived ? 1 : 0,
      n.trashed_at || null,
      n.locked ? 1 : 0,
      n.reminder_at || null,
      n.reminder_sent ? 1 : 0,
      serverNow,
      n.id
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO notes (id, owner_email, title, body, type, checklist_items, color, pinned, archived, trashed_at, locked, reminder_at, reminder_sent, last_modified, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      n.id,
      email,
      n.title || null,
      n.body || null,
      n.type || 'text',
      n.checklist_items ? JSON.stringify(n.checklist_items) : null,
      n.color || null,
      n.pinned ? 1 : 0,
      n.archived ? 1 : 0,
      n.trashed_at || null,
      n.locked ? 1 : 0,
      n.reminder_at || null,
      n.reminder_sent ? 1 : 0,
      serverNow,
      n.created_at || serverNow
    ).run();
  }

  if (Array.isArray(n.categories)) {
    await env.DB.prepare(`DELETE FROM note_categories WHERE note_id = ?`).bind(n.id).run();
    for (const cid of n.categories) {
      await env.DB.prepare(`INSERT OR IGNORE INTO note_categories (note_id, category_id) VALUES (?, ?)`)
        .bind(n.id, cid).run();
    }
  }
  return { skipped: false };
}

async function upsertCategory(env, email, c) {
  const existing = await env.DB.prepare(`SELECT updated_at, owner_email FROM categories WHERE id = ?`).bind(c.id).first();
  if (existing) {
    if (existing.owner_email !== email) return { skipped: true, reason: 'forbidden' };
    if (existing.updated_at > (c.updated_at || 0)) return { skipped: true, reason: 'older' };
    await env.DB.prepare(`UPDATE categories SET name=?, color=?, sort_order=?, updated_at=? WHERE id=?`)
      .bind(c.name, c.color, c.sort_order ?? existing.sort_order ?? 0, c.updated_at || now(), c.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO categories (id, owner_email, name, color, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(c.id, email, c.name, c.color, c.sort_order ?? 0, c.created_at || now(), c.updated_at || now()).run();
  }
  return { skipped: false };
}

async function syncPush(request, env, email) {
  const body = await request.json();
  const results = { notes: {}, categories: {} };
  await ensureUser(env, email);

  for (const n of body.notes || []) {
    try {
      results.notes[n.id] = await upsertNote(env, email, n);
    } catch (e) {
      results.notes[n.id] = { skipped: true, reason: e.message };
    }
  }
  for (const c of body.categories || []) {
    try {
      results.categories[c.id] = await upsertCategory(env, email, c);
    } catch (e) {
      results.categories[c.id] = { skipped: true, reason: e.message };
    }
  }

  // Pull all changed records since client's "since" so it gets canonical state
  const since = parseInt(body.since || 0, 10);
  const fresh = await fetchNotesForUser(env, email, since);
  // Always return ALL categories — deletes are only visible via absence
  const catRes = await env.DB.prepare(
    `SELECT * FROM categories WHERE owner_email = ? ORDER BY sort_order ASC, created_at ASC`
  ).bind(email).all();

  return json({ results, notes: fresh, categories: catRes.results || [], server_time: now() });
}

async function trashNote(noteId, env, email) {
  if (!(await canEdit(env, noteId, email))) return err('forbidden', 403);
  const t = now();
  await env.DB.prepare(`UPDATE notes SET trashed_at = ?, last_modified = ? WHERE id = ?`)
    .bind(t, t, noteId).run();
  return json({ ok: true });
}

async function restoreNote(noteId, env, email) {
  if (!(await canEdit(env, noteId, email))) return err('forbidden', 403);
  const t = now();
  await env.DB.prepare(`UPDATE notes SET trashed_at = NULL, last_modified = ? WHERE id = ?`)
    .bind(t, noteId).run();
  return json({ ok: true });
}

async function purgeNote(noteId, env, email) {
  const note = await env.DB.prepare(`SELECT owner_email FROM notes WHERE id = ?`).bind(noteId).first();
  if (!note) return err('not found', 404);
  if (note.owner_email !== email) return err('forbidden', 403);
  // delete R2 attachments
  const atts = await env.DB.prepare(`SELECT id, r2_key FROM attachments WHERE note_id = ?`).bind(noteId).all();
  for (const a of atts.results || []) {
    try { await env.BUCKET.delete(a.r2_key); } catch (_) {}
  }
  await env.DB.prepare(`DELETE FROM attachments WHERE note_id = ?`).bind(noteId).run();
  await env.DB.prepare(`DELETE FROM note_categories WHERE note_id = ?`).bind(noteId).run();
  await env.DB.prepare(`DELETE FROM note_shares WHERE note_id = ?`).bind(noteId).run();
  await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(noteId).run();
  return json({ ok: true });
}

// ── Sharing ─────────────────────────────────────────────────────────────────
async function shareNote(noteId, request, env, email) {
  const note = await env.DB.prepare(`SELECT owner_email FROM notes WHERE id = ?`).bind(noteId).first();
  if (!note) return err('not found', 404);
  if (note.owner_email !== email) return err('only owner can share', 403);
  const { email: targetEmail, can_edit } = await request.json();
  const target = (targetEmail || '').toLowerCase().trim();
  if (!target) return err('email required');
  if (target === email) return err('cannot share with self');
  await env.DB.prepare(
    `INSERT OR REPLACE INTO note_shares (note_id, shared_with_email, can_edit, shared_at) VALUES (?,?,?,?)`
  ).bind(noteId, target, can_edit === false ? 0 : 1, now()).run();
  return json({ ok: true });
}

async function revokeShare(noteId, targetEmail, env, email) {
  const note = await env.DB.prepare(`SELECT owner_email FROM notes WHERE id = ?`).bind(noteId).first();
  if (!note) return err('not found', 404);
  if (note.owner_email !== email) return err('only owner can revoke', 403);
  await env.DB.prepare(`DELETE FROM note_shares WHERE note_id = ? AND shared_with_email = ?`)
    .bind(noteId, (targetEmail || '').toLowerCase()).run();
  return json({ ok: true });
}

// ── Categories ──────────────────────────────────────────────────────────────
async function createCategory(request, env, email) {
  const b = await request.json();
  if (!b.name?.trim()) return err('name required');
  const id = b.id || uuid();
  const t = now();
  await env.DB.prepare(`INSERT INTO categories (id, owner_email, name, color, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, email, b.name.trim(), b.color || '#fbbf24', t, t).run();
  const row = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(id).first();
  return json({ category: row }, 201);
}

async function updateCategory(catId, request, env, email) {
  const cat = await env.DB.prepare(`SELECT owner_email FROM categories WHERE id = ?`).bind(catId).first();
  if (!cat) return err('not found', 404);
  if (cat.owner_email !== email) return err('forbidden', 403);
  const b = await request.json();
  const t = now();
  await env.DB.prepare(`UPDATE categories SET name = COALESCE(?, name), color = COALESCE(?, color), sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`)
    .bind(b.name || null, b.color || null, b.sort_order ?? null, t, catId).run();
  return json({ ok: true });
}

async function deleteCategory(catId, env, email) {
  const cat = await env.DB.prepare(`SELECT owner_email FROM categories WHERE id = ?`).bind(catId).first();
  if (!cat) return err('not found', 404);
  if (cat.owner_email !== email) return err('forbidden', 403);
  await env.DB.prepare(`DELETE FROM note_categories WHERE category_id = ?`).bind(catId).run();
  await env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(catId).run();
  return json({ ok: true });
}

// ── Attachments (R2) ────────────────────────────────────────────────────────
async function uploadAttachment(request, env, email) {
  const url = new URL(request.url);
  const noteId = url.searchParams.get('note_id');
  const type = url.searchParams.get('type') || 'image';
  const mime = request.headers.get('Content-Type') || 'application/octet-stream';
  if (!noteId) return err('note_id required');
  if (!(await canEdit(env, noteId, email))) return err('forbidden', 403);
  const id = uuid();
  const ext = mime.split('/')[1]?.split(';')[0] || 'bin';
  const key = `${email}/${noteId}/${id}.${ext}`;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 10 * 1024 * 1024) return err('file too large (max 10MB)', 413);
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    `INSERT INTO attachments (id, note_id, owner_email, type, r2_key, mime, size, created_at) VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, noteId, email, type, key, mime, buf.byteLength, now()).run();
  // bump note last_modified
  await env.DB.prepare(`UPDATE notes SET last_modified = ? WHERE id = ?`).bind(now(), noteId).run();
  return json({ id, type, mime, size: buf.byteLength }, 201);
}

async function getAttachment(id, env, email) {
  const a = await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?`).bind(id).first();
  if (!a) return err('not found', 404);
  // access check: owner OR shared on note
  const allowed = (a.owner_email === email) ||
    !!(await env.DB.prepare(`SELECT 1 FROM note_shares WHERE note_id = ? AND shared_with_email = ?`)
      .bind(a.note_id, email).first());
  if (!allowed) return err('forbidden', 403);
  const obj = await env.BUCKET.get(a.r2_key);
  if (!obj) return err('blob missing', 410);
  return new Response(obj.body, {
    headers: {
      'Content-Type': a.mime || 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
      ...CORS,
    },
  });
}

async function deleteAttachment(id, env, email) {
  const a = await env.DB.prepare(`SELECT * FROM attachments WHERE id = ?`).bind(id).first();
  if (!a) return err('not found', 404);
  if (!(await canEdit(env, a.note_id, email))) return err('forbidden', 403);
  try { await env.BUCKET.delete(a.r2_key); } catch (_) {}
  await env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(id).run();
  await env.DB.prepare(`UPDATE notes SET last_modified = ? WHERE id = ?`).bind(now(), a.note_id).run();
  return json({ ok: true });
}

// ── Web Push (VAPID) ────────────────────────────────────────────────────────
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signVapidJwt(payload, privateJwk) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const enc = new TextEncoder();
  const headB64 = bytesToB64url(enc.encode(JSON.stringify(header)));
  const payB64  = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(`${headB64}.${payB64}`);
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return `${headB64}.${payB64}.${bytesToB64url(new Uint8Array(sig))}`;
}

function vapidRawToJwk(privateB64url, publicB64url) {
  // publicB64url = 87-char base64url of uncompressed P-256 point (0x04 || x || y)
  const pub = b64urlToBytes(publicB64url);
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  return { kty: 'EC', crv: 'P-256', d: privateB64url, x, y };
}

async function sendWebPush(env, subscription, payload) {
  const hasPub = !!env.VAPID_PUBLIC;
  const hasJwk = !!env.VAPID_PRIVATE_JWK;
  const hasRaw = !!env.VAPID_PRIVATE;
  if (!hasPub || (!hasJwk && !hasRaw)) return false;
  let privateJwk;
  try {
    privateJwk = hasJwk
      ? JSON.parse(env.VAPID_PRIVATE_JWK)
      : vapidRawToJwk(env.VAPID_PRIVATE, env.VAPID_PUBLIC);
  } catch { return false; }
  const url = new URL(subscription.endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const sub = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const jwt = await signVapidJwt({ aud, exp, sub }, privateJwk);

  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = {
    'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    'Content-Encoding': 'aes128gcm',
    'TTL': '86400',
  };
  // Note: a full implementation requires payload encryption with the user's
  // p256dh+auth keys (RFC 8291). For simplicity we send a header-only push;
  // most browsers will deliver an empty notification handled by the SW.
  try {
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: new Uint8Array(0) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function dispatchReminders(env) {
  const t = now();
  const due = await env.DB.prepare(
    `SELECT id, owner_email, title FROM notes
     WHERE reminder_at IS NOT NULL AND reminder_at <= ? AND reminder_sent = 0 AND trashed_at IS NULL`
  ).bind(t).all();
  for (const n of due.results || []) {
    const subRaw = await env.PUSH_KV.get(`push:${n.owner_email}`);
    if (subRaw) {
      try {
        const sub = JSON.parse(subRaw);
        await sendWebPush(env, sub, { title: 'Recordatorio', body: n.title || 'Tienes una nota', noteId: n.id });
      } catch (_) {}
    }
    await env.DB.prepare(`UPDATE notes SET reminder_sent = 1 WHERE id = ?`).bind(n.id).run();
  }
}

async function purgeOldTrash(env) {
  const cutoff = now() - 30 * 24 * 3600 * 1000;
  const rows = await env.DB.prepare(
    `SELECT id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at < ?`
  ).bind(cutoff).all();
  for (const r of rows.results || []) {
    const atts = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE note_id = ?`).bind(r.id).all();
    for (const a of atts.results || []) {
      try { await env.BUCKET.delete(a.r2_key); } catch (_) {}
    }
    await env.DB.prepare(`DELETE FROM attachments WHERE note_id = ?`).bind(r.id).run();
    await env.DB.prepare(`DELETE FROM note_categories WHERE note_id = ?`).bind(r.id).run();
    await env.DB.prepare(`DELETE FROM note_shares WHERE note_id = ?`).bind(r.id).run();
    await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(r.id).run();
  }
}

// ── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!authToken(request, env)) return err('Unauthorized', 401);
    const email = getUser(request);
    if (!email) return err('User identity required', 401);

    try { await migrate(env); }
    catch (e) { return err('DB init failed: ' + e.message, 500); }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = request.method;
    const seg = path.split('/').filter(Boolean);

    try {
      if (path === '/me'                       && m === 'GET')  return await getMe(env, email);
      if (path === '/me/pin'                   && m === 'POST') return await setPin(request, env, email);
      if (path === '/me/pin/verify'            && m === 'POST') return await verifyPin(request, env, email);
      if (path === '/me/webauthn/register'     && m === 'POST') return await registerWebauthn(request, env, email);
      if (path === '/me/webauthn'              && m === 'GET')  return await getWebauthnInfo(env, email);
      if (path === '/me/push'                  && m === 'POST') return await setPushSubscription(request, env, email);
      if (path === '/vapid'                    && m === 'GET')  return await getVapidPublic(env);

      if (path === '/sync' && m === 'GET')  return await syncPull(request, env, email);
      if (path === '/sync' && m === 'POST') return await syncPush(request, env, email);

      if (seg[0] === 'notes' && seg.length === 1 && m === 'POST') {
        // create-or-update single note (used as fallback when batch sync isn't needed)
        const body = await request.json();
        if (!body.id) body.id = uuid();
        if (!body.created_at) body.created_at = now();
        body.last_modified = now();
        await ensureUser(env, email);
        await upsertNote(env, email, body);
        return json({ id: body.id }, 201);
      }
      if (seg[0] === 'notes' && seg[1] && seg.length === 2 && m === 'PATCH') {
        const body = await request.json();
        body.id = seg[1];
        body.last_modified = now();
        await upsertNote(env, email, body);
        return json({ ok: true });
      }
      if (seg[0] === 'notes' && seg[1] && seg[2] === 'restore' && m === 'POST') return await restoreNote(seg[1], env, email);
      if (seg[0] === 'notes' && seg[1] && seg[2] === 'purge'   && m === 'DELETE') return await purgeNote(seg[1], env, email);
      if (seg[0] === 'notes' && seg[1] && seg.length === 2 && m === 'DELETE') return await trashNote(seg[1], env, email);
      if (seg[0] === 'notes' && seg[1] && seg[2] === 'share'   && m === 'POST') return await shareNote(seg[1], request, env, email);
      if (seg[0] === 'notes' && seg[1] && seg[2] === 'share' && seg[3] && m === 'DELETE') return await revokeShare(seg[1], seg[3], env, email);

      if (path === '/categories' && m === 'POST') return await createCategory(request, env, email);
      if (seg[0] === 'categories' && seg[1] && m === 'PATCH')  return await updateCategory(seg[1], request, env, email);
      if (seg[0] === 'categories' && seg[1] && m === 'DELETE') return await deleteCategory(seg[1], env, email);

      if (path === '/attachments/upload' && m === 'POST') return await uploadAttachment(request, env, email);
      if (seg[0] === 'attachments' && seg[1] && m === 'GET')    return await getAttachment(seg[1], env, email);
      if (seg[0] === 'attachments' && seg[1] && m === 'DELETE') return await deleteAttachment(seg[1], env, email);

      return err('Not found', 404);
    } catch (e) {
      return err(e.message, 500);
    }
  },

  async scheduled(event, env) {
    try { await migrate(env); } catch (_) {}
    await dispatchReminders(env);
    // Run trash purge once per day around hour 0 UTC
    const d = new Date(event.scheduledTime || Date.now());
    if (d.getUTCHours() === 0 && d.getUTCMinutes() < 5) {
      await purgeOldTrash(env);
    }
  },
};
