// habits-worker — Cloudflare Worker + D1

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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

// ── DB bootstrap ──────────────────────────────────────────────────────────────
async function migrate(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'binary',
      target_value REAL DEFAULT 1,
      target_unit TEXT DEFAULT 'veces',
      frequency TEXT NOT NULL DEFAULT 'daily',
      frequency_days TEXT,
      frequency_every INTEGER DEFAULT 1,
      color TEXT NOT NULL DEFAULT 'lavender',
      emoji TEXT NOT NULL DEFAULT '✓',
      reminder_time TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS completions (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL,
      date TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 1,
      note TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(habit_id, date)
    );
  `);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function getHabits(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM habits WHERE active = 1 ORDER BY sort_order, created_at`
  ).all();
  return json({ habits: results });
}

async function createHabit(request, env) {
  const b = await request.json();
  if (!b.name?.trim()) return err('name required');
  const now = Math.floor(Date.now() / 1000);
  const id  = uuid();
  await env.DB.prepare(`
    INSERT INTO habits (id,name,description,type,target_value,target_unit,frequency,frequency_days,frequency_every,color,emoji,reminder_time,sort_order,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id,
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
    b.sort_order ?? 0,
    now
  ).run();
  const row = await env.DB.prepare(`SELECT * FROM habits WHERE id = ?`).bind(id).first();
  return json({ habit: row }, 201);
}

async function updateHabit(id, request, env) {
  const b = await request.json();
  const fields = [];
  const vals   = [];
  const allowed = ['name','description','type','target_value','target_unit','frequency',
                   'frequency_days','frequency_every','color','emoji','reminder_time','sort_order'];
  for (const k of allowed) {
    if (k in b) {
      fields.push(`${k} = ?`);
      vals.push(k === 'frequency_days' && Array.isArray(b[k]) ? JSON.stringify(b[k]) : b[k]);
    }
  }
  if (!fields.length) return err('nothing to update');
  vals.push(id);
  await env.DB.prepare(`UPDATE habits SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
  const row = await env.DB.prepare(`SELECT * FROM habits WHERE id = ?`).bind(id).first();
  return json({ habit: row });
}

async function deleteHabit(id, env) {
  await env.DB.prepare(`UPDATE habits SET active = 0 WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function getCompletions(request, env) {
  const url  = new URL(request.url);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');
  if (!from || !to) return err('from and to required');
  const { results } = await env.DB.prepare(
    `SELECT * FROM completions WHERE date >= ? AND date <= ? ORDER BY date`
  ).bind(from, to).all();
  return json({ completions: results });
}

async function toggleCompletion(request, env) {
  const b = await request.json();
  const { habit_id, date, value = 1 } = b;
  if (!habit_id || !date) return err('habit_id and date required');

  // Check if already completed
  const existing = await env.DB.prepare(
    `SELECT id FROM completions WHERE habit_id = ? AND date = ?`
  ).bind(habit_id, date).first();

  if (existing) {
    // Toggle off
    await env.DB.prepare(`DELETE FROM completions WHERE habit_id = ? AND date = ?`)
      .bind(habit_id, date).run();
    return json({ toggled: 'off', date, habit_id });
  } else {
    // Toggle on (upsert)
    const id  = uuid();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO completions (id,habit_id,date,value,created_at) VALUES (?,?,?,?,?)`
    ).bind(id, habit_id, date, value, now).run();
    return json({ toggled: 'on', date, habit_id, value });
  }
}

async function setCompletion(request, env) {
  // For quantitative: set specific value without toggle
  const b = await request.json();
  const { habit_id, date, value } = b;
  if (!habit_id || !date || value == null) return err('habit_id, date, value required');

  if (value <= 0) {
    await env.DB.prepare(`DELETE FROM completions WHERE habit_id = ? AND date = ?`)
      .bind(habit_id, date).run();
    return json({ ok: true, value: 0 });
  }
  const id  = uuid();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO completions (id,habit_id,date,value,created_at) VALUES (?,?,?,?,?)`
  ).bind(id, habit_id, date, value, now).run();
  return json({ ok: true, value });
}

async function getStats(request, env) {
  const url   = new URL(request.url);
  const month = url.searchParams.get('month'); // YYYY-MM
  if (!month) return err('month required');

  const from = `${month}-01`;
  const to   = `${month}-31`;

  const { results: habits } = await env.DB.prepare(
    `SELECT id, name, frequency, frequency_days, frequency_every, color FROM habits WHERE active = 1`
  ).all();
  const { results: comps } = await env.DB.prepare(
    `SELECT habit_id, date, value FROM completions WHERE date >= ? AND date <= ?`
  ).bind(from, to).all();

  // Build completion map
  const compMap = {};
  for (const c of comps) {
    if (!compMap[c.habit_id]) compMap[c.habit_id] = {};
    compMap[c.habit_id][c.date] = c.value;
  }

  // Compute per-habit stats
  const stats = habits.map(h => {
    const done = Object.keys(compMap[h.id] || {}).length;
    return { habit_id: h.id, name: h.name, color: h.color, completions: done };
  });

  // Daily completion percentages for heatmap
  const daily = {};
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    let done = 0;
    for (const h of habits) {
      if (compMap[h.id]?.[date]) done++;
    }
    daily[date] = habits.length > 0 ? Math.round(done / habits.length * 100) : 0;
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

    try {
      await migrate(env);
    } catch (e) {
      return err('DB init failed: ' + e.message, 500);
    }

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method;
    const seg    = path.split('/').filter(Boolean); // ['habits', 'abc']

    try {
      // Habits
      if (path === '/habits' && method === 'GET')  return await getHabits(env);
      if (path === '/habits' && method === 'POST') return await createHabit(request, env);
      if (seg[0] === 'habits' && seg[1] && method === 'PUT')    return await updateHabit(seg[1], request, env);
      if (seg[0] === 'habits' && seg[1] && method === 'DELETE') return await deleteHabit(seg[1], env);

      // Completions
      if (path === '/completions' && method === 'GET')           return await getCompletions(request, env);
      if (path === '/completions/toggle' && method === 'POST')   return await toggleCompletion(request, env);
      if (path === '/completions/set'    && method === 'POST')   return await setCompletion(request, env);

      // Stats
      if (path === '/stats' && method === 'GET') return await getStats(request, env);

      return err('Not found', 404);
    } catch (e) {
      return err(e.message, 500);
    }
  },
};
