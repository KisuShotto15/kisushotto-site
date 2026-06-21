// habits-worker — Cloudflare Worker + D1

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-User-Email',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function err(msg, status = 400) {
  return json({ error: msg }, status);
}
function uuid() {
  return crypto.randomUUID();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function auth(request, env) {
  const h = request.headers.get('Authorization') || '';
  return h === `Bearer ${env.TOKEN}`;
}

// Extracts user email from X-User-Email header (set by frontend via CF Access JWT)
function getUser(request) {
  return (request.headers.get('X-User-Email') || '').toLowerCase().trim() || null;
}

// Local date + HH:MM for a given IANA timezone (reminders are stored in local time)
const DEFAULT_TZ = 'UTC';
function localParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

// ── Frequency helper ──────────────────────────────────────────────────────────
function isDueOn(habit, dateISO) {
  const d   = new Date(dateISO + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const dom = d.getUTCDate();
  const mon = d.getUTCMonth() + 1;

  if (habit.frequency === 'daily') return true;

  if (habit.frequency === 'weekly') {
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1,2,3,4,5];
    return days.includes(dow);
  }

  if (habit.frequency === 'custom') {
    const every  = habit.frequency_every || 1;
    const fd     = habit.frequency_days ? JSON.parse(habit.frequency_days) : [];
    const origin = fd[0] ? new Date(fd[0] + 'T00:00:00') : new Date(habit.created_at * 1000);
    const diff   = Math.floor((d - origin) / 86400000);
    return diff >= 0 && diff % every === 0;
  }

  if (habit.frequency === 'monthly') {
    const days = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1];
    return days.includes(dom);
  }

  if (habit.frequency === 'every_n_months') {
    const every       = habit.frequency_every || 3;
    const day         = habit.frequency_days ? JSON.parse(habit.frequency_days)[0] : 1;
    if (dom !== day) return false;
    const origin      = new Date(habit.created_at * 1000);
    const originMonth = origin.getUTCFullYear() * 12 + origin.getUTCMonth();
    const checkMonth  = d.getUTCFullYear() * 12 + d.getUTCMonth();
    return (checkMonth - originMonth) % every === 0;
  }

  if (habit.frequency === 'yearly') {
    const [m, day] = habit.frequency_days ? JSON.parse(habit.frequency_days) : [1, 1];
    return mon === m && dom === day;
  }

  return true;
}

function isoUTC(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Current streak: walk back from today over the full completion history.
function calcStreak(habit, doneSet, todayISO) {
  let streak = 0;
  const d = new Date(todayISO + 'T00:00:00Z');
  for (let i = 0; i < 3660; i++) {        // cap ~10 years
    const ds = isoUTC(d);
    if (isDueOn(habit, ds)) {
      if (doneSet.has(ds)) streak++;
      else if (ds !== todayISO) break;     // today may still be incomplete
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}

// ── VAPID / Web Push ──────────────────────────────────────────────────────────
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

async function sendWebPush(env, subscription, payload) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return false;
  let privateJwk;
  try { privateJwk = JSON.parse(env.VAPID_PRIVATE_JWK); } catch { return false; }
  const url = new URL(subscription.endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const sub = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const jwt = await signVapidJwt({ aud, exp, sub }, privateJwk);
  const headers = {
    'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    'Content-Encoding': 'aes128gcm',
    'TTL': '86400',
  };
  try {
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body: new Uint8Array(0) });
    return res.ok;
  } catch { return false; }
}

async function setPushSubscription(request, env, uid) {
  const sub = await request.json();
  if (!sub?.endpoint) return err('subscription required');
  await env.PUSH_KV.put(`push:${uid}`, JSON.stringify(sub));
  return json({ ok: true });
}

async function getVapidPublic(env) {
  return json({ key: env.VAPID_PUBLIC || null });
}

async function dispatchReminders(env) {
  // Candidates: any active habit with a reminder pending today. Time/zone/due are
  // evaluated per-habit below because reminder_time is stored in the user's local time.
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, name, frequency, frequency_days, frequency_every, created_at,
            reminder_time, reminder_last_sent, tz
     FROM habits WHERE active = 1 AND reminder_time IS NOT NULL`
  ).all();

  for (const h of results || []) {
    const { date: localDate, hhmm } = localParts(h.tz);
    if (h.reminder_time !== hhmm) continue;
    if (h.reminder_last_sent === localDate) continue;
    if (!isDueOn(h, localDate)) continue;

    const done = await env.DB.prepare(
      `SELECT 1 FROM completions WHERE user_id = ? AND habit_id = ? AND date = ? AND value > 0`
    ).bind(h.user_id, h.id, localDate).first();
    if (done) continue;

    const subRaw = await env.PUSH_KV.get(`push:${h.user_id}`);
    if (subRaw) {
      try {
        const sub = JSON.parse(subRaw);
        await sendWebPush(env, sub, { title: h.name, body: 'Es hora de tu habito' });
      } catch (_) {}
    }
    await env.DB.prepare(`UPDATE habits SET reminder_last_sent = ? WHERE id = ?`).bind(localDate, h.id).run();
  }
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────
async function migrate(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS habits (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'binary', target_value REAL DEFAULT 1, target_unit TEXT DEFAULT 'veces', frequency TEXT NOT NULL DEFAULT 'daily', frequency_days TEXT, frequency_every INTEGER DEFAULT 1, color TEXT NOT NULL DEFAULT 'lavender', emoji TEXT NOT NULL DEFAULT '✓', reminder_time TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS completions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', habit_id TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL DEFAULT 1, note TEXT, created_at INTEGER NOT NULL, UNIQUE(habit_id, date))").run();
  // Add user_id to existing tables if missing (safe to run multiple times)
  try { await env.DB.prepare("ALTER TABLE habits ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE completions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE habits ADD COLUMN reminder_last_sent TEXT").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE habits ADD COLUMN tz TEXT").run(); } catch (_) {}
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function getHabits(request, env, uid) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM habits WHERE active = 1 AND user_id = ? ORDER BY sort_order, created_at`
  ).bind(uid).all();

  const url      = new URL(request.url);
  const todayISO = url.searchParams.get('today') || isoUTC(new Date());

  const { results: comps } = await env.DB.prepare(
    `SELECT habit_id, date FROM completions WHERE user_id = ? AND value > 0`
  ).bind(uid).all();

  const doneByHabit = {};
  for (const c of comps) {
    (doneByHabit[c.habit_id] ||= new Set()).add(c.date);
  }
  for (const h of results) {
    h.streak = calcStreak(h, doneByHabit[h.id] || new Set(), todayISO);
  }

  return json({ habits: results });
}

async function createHabit(request, env, uid) {
  const b = await request.json();
  if (!b.name?.trim()) return err('name required');
  const now = Math.floor(Date.now() / 1000);
  const id  = uuid();
  await env.DB.prepare(
    `INSERT INTO habits (id,user_id,name,description,type,target_value,target_unit,frequency,frequency_days,frequency_every,color,emoji,reminder_time,tz,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, uid,
    b.name.trim(),
    b.description || null,
    b.type || 'binary',
    b.target_value ?? 1,
    b.target_unit || 'veces',
    b.frequency || 'daily',
    b.frequency_days ? JSON.stringify(b.frequency_days) : null,
    b.frequency_every ?? 1,
    b.color || 'lavender',
    b.emoji || '✓',
    b.reminder_time || null,
    b.tz || null,
    b.sort_order ?? 0,
    now
  ).run();
  const row = await env.DB.prepare(`SELECT * FROM habits WHERE id = ?`).bind(id).first();
  return json({ habit: row }, 201);
}

async function updateHabit(id, request, env, uid) {
  const b = await request.json();
  const fields = [];
  const vals   = [];
  const allowed = ['name','description','type','target_value','target_unit','frequency',
                   'frequency_days','frequency_every','color','emoji','reminder_time','tz','sort_order'];
  for (const k of allowed) {
    if (k in b) {
      fields.push(`${k} = ?`);
      vals.push(k === 'frequency_days' && Array.isArray(b[k]) ? JSON.stringify(b[k]) : b[k]);
    }
  }
  if (!fields.length) return err('nothing to update');
  vals.push(id, uid);
  await env.DB.prepare(`UPDATE habits SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).bind(...vals).run();
  const row = await env.DB.prepare(`SELECT * FROM habits WHERE id = ?`).bind(id).first();
  return json({ habit: row });
}

async function deleteHabit(id, env, uid) {
  await env.DB.prepare(`UPDATE habits SET active = 0 WHERE id = ? AND user_id = ?`).bind(id, uid).run();
  return json({ ok: true });
}

async function getCompletions(request, env, uid) {
  const url  = new URL(request.url);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');
  if (!from || !to) return err('from and to required');
  const { results } = await env.DB.prepare(
    `SELECT * FROM completions WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`
  ).bind(uid, from, to).all();
  return json({ completions: results });
}

async function toggleCompletion(request, env, uid) {
  const b = await request.json();
  const { habit_id, date, value = 1 } = b;
  if (!habit_id || !date) return err('habit_id and date required');

  const existing = await env.DB.prepare(
    `SELECT id FROM completions WHERE user_id = ? AND habit_id = ? AND date = ?`
  ).bind(uid, habit_id, date).first();

  if (existing) {
    await env.DB.prepare(`DELETE FROM completions WHERE user_id = ? AND habit_id = ? AND date = ?`)
      .bind(uid, habit_id, date).run();
    return json({ toggled: 'off', date, habit_id });
  } else {
    const id  = uuid();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO completions (id,user_id,habit_id,date,value,created_at) VALUES (?,?,?,?,?,?)`
    ).bind(id, uid, habit_id, date, value, now).run();
    return json({ toggled: 'on', date, habit_id, value });
  }
}

async function setCompletion(request, env, uid) {
  const b = await request.json();
  const { habit_id, date, value } = b;
  if (!habit_id || !date || value == null) return err('habit_id, date, value required');

  if (value <= 0) {
    await env.DB.prepare(`DELETE FROM completions WHERE user_id = ? AND habit_id = ? AND date = ?`)
      .bind(uid, habit_id, date).run();
    return json({ ok: true, value: 0 });
  }
  const id  = uuid();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO completions (id,user_id,habit_id,date,value,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(id, uid, habit_id, date, value, now).run();
  return json({ ok: true, value });
}

async function getStats(request, env, uid) {
  const url   = new URL(request.url);
  const month = url.searchParams.get('month');
  if (!month) return err('month required');

  const from = `${month}-01`;
  const to   = `${month}-31`;

  const { results: habits } = await env.DB.prepare(
    `SELECT id, name, frequency, frequency_days, frequency_every, color, created_at FROM habits WHERE active = 1 AND user_id = ?`
  ).bind(uid).all();
  const { results: comps } = await env.DB.prepare(
    `SELECT habit_id, date, value FROM completions WHERE user_id = ? AND date >= ? AND date <= ?`
  ).bind(uid, from, to).all();

  const compMap = {};
  for (const c of comps) {
    if (!compMap[c.habit_id]) compMap[c.habit_id] = {};
    compMap[c.habit_id][c.date] = c.value;
  }

  const stats = habits.map(h => {
    const done = Object.keys(compMap[h.id] || {}).length;
    return { habit_id: h.id, name: h.name, color: h.color, completions: done };
  });

  const daily = {};
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const due  = habits.filter(h => isDueOn(h, date));
    const done = due.filter(h => compMap[h.id]?.[date]).length;
    daily[date] = due.length > 0 ? Math.round(done / due.length * 100) : 0;
  }

  return json({ stats, daily, total_habits: habits.length });
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!auth(request, env)) return err('Unauthorized', 401);

    const uid = getUser(request);
    if (!uid) return err('User identity required', 401);

    try {
      await migrate(env);
    } catch (e) {
      return err('DB init failed: ' + e.message, 500);
    }

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method;
    const seg    = path.split('/').filter(Boolean);

    try {
      if (path === '/me/push' && method === 'POST') return await setPushSubscription(request, env, uid);
      if (path === '/vapid'   && method === 'GET')  return await getVapidPublic(env);

      if (path === '/habits' && method === 'GET')  return await getHabits(request, env, uid);
      if (path === '/habits' && method === 'POST') return await createHabit(request, env, uid);
      if (seg[0] === 'habits' && seg[1] && method === 'PUT')    return await updateHabit(seg[1], request, env, uid);
      if (seg[0] === 'habits' && seg[1] && method === 'DELETE') return await deleteHabit(seg[1], env, uid);

      if (path === '/completions' && method === 'GET')           return await getCompletions(request, env, uid);
      if (path === '/completions/toggle' && method === 'POST')   return await toggleCompletion(request, env, uid);
      if (path === '/completions/set'    && method === 'POST')   return await setCompletion(request, env, uid);

      if (path === '/stats' && method === 'GET') return await getStats(request, env, uid);

      return err('Not found', 404);
    } catch (e) {
      return err(e.message, 500);
    }
  },

  async scheduled(_event, env) {
    try { await migrate(env); } catch (_) {}
    await dispatchReminders(env);
  },
};
