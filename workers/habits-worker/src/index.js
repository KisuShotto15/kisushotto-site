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

// A habit is inactive only from its pause date forward; days before keep history.
function pausedOn(habit, dateISO) {
  return !!(habit.paused && habit.paused_at && dateISO >= habit.paused_at);
}
function activeDueOn(habit, dateISO) {
  return isDueOn(habit, dateISO) && !pausedOn(habit, dateISO);
}

// A completion counts as "done" only if a count habit reaches its target.
function habitDone(habit, value) {
  if (value == null) return false;
  return habit.type === 'count' ? value >= (habit.target_value || 1) : value > 0;
}

// Current streak: walk back from today over the full completion history.
function calcStreak(habit, doneSet, todayISO) {
  let streak = 0;
  const d = new Date(todayISO + 'T00:00:00Z');
  for (let i = 0; i < 3660; i++) {        // cap ~10 years
    const ds = isoUTC(d);
    if (activeDueOn(habit, ds)) {
      if (doneSet.has(ds)) streak++;
      else if (ds !== todayISO) break;     // today may still be incomplete
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}

// Record (longest-ever) streak across the full history.
function calcRecord(habit, doneSet, todayISO) {
  let best = 0, run = 0;
  const d = new Date(todayISO + 'T00:00:00Z');
  for (let i = 0; i < 3660; i++) {
    const ds = isoUTC(d);
    if (activeDueOn(habit, ds)) {
      if (doneSet.has(ds)) { run++; if (run > best) best = run; }
      else if (ds !== todayISO) run = 0;   // a real miss breaks the run
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return best;
}

// Completion rate over the last N scheduled (due) days, excluding today.
function calcRate(habit, doneSet, todayISO, n) {
  let due = 0, done = 0;
  const d = new Date(todayISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);        // start yesterday (today may be pending)
  for (let i = 0; i < 3660 && due < n; i++) {
    const ds = isoUTC(d);
    if (activeDueOn(habit, ds)) { due++; if (doneSet.has(ds)) done++; }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return due ? Math.round(done / due * 100) : 0;
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

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Encrypt a payload for Web Push (RFC 8291 + aes128gcm RFC 8188).
async function encryptPayload(subscription, payloadStr) {
  const enc       = new TextEncoder();
  const uaPublic  = b64urlToBytes(subscription.keys.p256dh); // 65 bytes
  const auth      = b64urlToBytes(subscription.keys.auth);   // 16 bytes
  const plaintext = enc.encode(payloadStr);

  const asKeys   = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaKey    = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh     = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm     = await hkdf(auth, ecdh, keyInfo, 32);

  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = concatBytes(plaintext, new Uint8Array([0x02])); // last-record delimiter
  const ct     = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // header: salt(16) | record_size(4=4096) | idlen(1=65) | keyid(asPublic)
  const header = concatBytes(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPublic.length]), asPublic);
  return concatBytes(header, ct);
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

  let body = new Uint8Array(0);
  const headers = {
    'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    'Content-Encoding': 'aes128gcm',
    'TTL': '86400',
  };
  // Encrypt the payload when the subscription exposes its keys; otherwise send a
  // contentless push (the SW falls back to a generic message).
  if (payload && subscription.keys?.p256dh && subscription.keys?.auth) {
    try {
      body = await encryptPayload(subscription, JSON.stringify(payload));
      headers['Content-Type'] = 'application/octet-stream';
    } catch { body = new Uint8Array(0); }
  }
  try {
    const res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
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
    `SELECT id, user_id, name, emoji, description, type, target_value, frequency, frequency_days,
            frequency_every, created_at, reminder_time, reminder_last_sent, tz
     FROM habits WHERE active = 1 AND paused = 0 AND reminder_time IS NOT NULL`
  ).all();

  for (const h of results || []) {
    const { date: localDate, hhmm } = localParts(h.tz);
    if (h.reminder_time !== hhmm) continue;
    if (h.reminder_last_sent === localDate) continue;
    if (!isDueOn(h, localDate)) continue;

    const comp = await env.DB.prepare(
      `SELECT value FROM completions WHERE user_id = ? AND habit_id = ? AND date = ?`
    ).bind(h.user_id, h.id, localDate).first();
    if (comp && habitDone(h, comp.value)) continue;   // already met target

    const subRaw = await env.PUSH_KV.get(`push:${h.user_id}`);
    if (subRaw) {
      try {
        const sub = JSON.parse(subRaw);
        await sendWebPush(env, sub, {
          title: `${h.emoji || '⏰'} ${h.name}`,
          body:  h.description || 'Es hora de completar tu habito',
          tag:   h.id,
        });
      } catch (_) {}
    }
    await env.DB.prepare(`UPDATE habits SET reminder_last_sent = ? WHERE id = ?`).bind(localDate, h.id).run();
  }
}

// ── Health (health.kisushotto.com) ────────────────────────────────────────────
// Backend de la app Health. Cada usuario entra con su cuenta de Supabase (la
// misma de Portfolio: codigo por correo o passkey) y todos sus datos se guardan
// en health_kv con la clave "<email>|<dato>". Los recordatorios por push
// reutilizan las llaves VAPID de este worker.

// Valida el token de Supabase y devuelve el email. Cache corto por isolate
// para no consultar a Supabase en cada pedido.
const _healthUsers = new Map(); // token -> { email, until }
async function healthUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL) return null;
  const hit = _healthUsers.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!r.ok) return null;
  const email = ((await r.json())?.email || '').toLowerCase();
  if (!email) return null;
  if (_healthUsers.size > 500) _healthUsers.clear();
  _healthUsers.set(token, { email, until: Date.now() + 5 * 60 * 1000 });
  return email;
}

async function healthGet(env, user, k) {
  const row = await env.DB.prepare('SELECT v FROM health_kv WHERE k = ?').bind(user + '|' + k).first();
  return row ? JSON.parse(row.v) : null;
}
async function healthSet(env, user, k, v) {
  await env.DB.prepare(
    'INSERT INTO health_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
  ).bind(user + '|' + k, JSON.stringify(v), Date.now()).run();
}

// Cambiar un solo dia de un registro ({ 'YYYY-MM-DD': ... }) en una sola sentencia,
// sin leer y reescribir todo: dos marcas a la vez (dos chips seguidos, o la
// notificacion con la app abierta) ya no se pisan. merge: se suman campos al dia;
// si no, el dia se reemplaza (null lo borra).
async function healthDay(env, user, k, date, val, merge = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('fecha invalida');
  const key = user + '|' + k, path = `$."${date}"`, j = JSON.stringify(val), now = Date.now();
  if (val == null) {
    await env.DB.prepare('UPDATE health_kv SET v = json_remove(v, ?), updated_at = ? WHERE k = ?').bind(path, now, key).run();
    return;
  }
  const upd = merge ? "json_set(v, ?, json_patch(coalesce(json_extract(v, ?), '{}'), json(?)))" : 'json_set(v, ?, json(?))';
  const binds = merge ? [path, path, j] : [path, j];
  await env.DB.prepare(`INSERT INTO health_kv (k, v, updated_at) VALUES (?, json_object(?, json(?)), ?)
    ON CONFLICT(k) DO UPDATE SET v = ${upd}, updated_at = excluded.updated_at`).bind(key, date, j, now, ...binds).run();
}

// ── Push a la app Android de Health por FCM (API HTTP v1) ────────────────────
// Un JWT firmado con la cuenta de servicio se cambia por un access token de OAuth.
// La cuenta de servicio es el secret FIREBASE_SERVICE_ACCOUNT (el JSON entero de
// Firebase, el mismo proyecto que Portfolio); sin el, la app no ofrece push.
function serviceAccount(env) {
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '');
    return sa?.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch { return null; }
}
const b64urlBytes = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = o => b64urlBytes(new TextEncoder().encode(JSON.stringify(o)));
let fcmAuth = null; // { token, exp }: el access token dura una hora
async function fcmAccessToken(sa) {
  if (fcmAuth && fcmAuth.exp > Date.now() + 60000) return fcmAuth.token;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = b64urlJson({ alg: 'RS256', typ: 'JWT' }) + '.' + b64urlJson({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64urlBytes(sig) }),
  });
  if (!r.ok) throw new Error('oauth ' + r.status);
  const j = await r.json();
  fcmAuth = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmAuth.token;
}
// channel_id y el icono existen en el APK (PushService / ic_stat_notify); url va en
// data: al tocar la notificacion la app abre esa pestana.
// v >= 2 (app nueva): mensaje solo de datos, la app arma la notificacion (con los
// botones para responder). Las apps viejas reciben la notificacion de siempre.
async function sendFcm(env, token, p, v = 1) {
  const sa = serviceAccount(env);
  if (!sa) return false;
  const data = { url: p.url || '/', tag: p.tag || 'health' };
  const message = v >= 2
    ? { token, data: { ...data, title: p.title, body: p.body, kind: p.kind || '', quick: p.quick || '', actions: JSON.stringify(p.actions || []), alarm: p.alarm ? '1' : '' },
        android: { priority: 'HIGH' } }
    : { token, notification: { title: p.title, body: p.body }, data,
        android: { priority: 'HIGH', notification: { channel_id: 'reminders', tag: p.tag || 'health', icon: 'ic_stat_notify', color: '#4F86FF' } } };
  try {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await fcmAccessToken(sa), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    return r.ok;
  } catch { return false; }
}

// ── Frases que duelen: rotan cada dia; se mezclan con las propias (Ajustes) ──
// {rutina} {hora} {inicio} {fin} se reemplazan. alarm: suena aunque el telefono
// este en silencio y sigue sonando hasta que lo tocas (app Android).
const STINGS = {
  wake: [
    'Son las {hora}. Cada minuto en la cama es un minuto que le regalas a la versión de ti que no avanza.',
    'Arriba. El que eras hace un año ya estaría de pie.',
    'Si te quedas acostado, el día se decide solo. Levántate y decídelo tú.',
    'Nadie va a venir a levantarte. Ni hoy ni nunca. Arriba.',
    '"Cinco minutos más" se convierten en una mañana perdida. Ya conoces el final.',
    'Tu yo de hace 12 meses no fallaba un día. Demuéstrale que sigue ahí.',
    'Cada mañana que te levantas tarde, el día empieza perdiendo. Arriba.',
    'Dormir de más no te va a quitar el cansancio. Levantarte a tu hora, sí.',
  ],
  jp: [
    'No estudiar japonés hoy te aleja de Japón.',
    'Cada día sin repasar, Anki se te acumula y Japón queda más lejos.',
    'Tu yo en Japón depende de los repasos de hoy. 10 minutos.',
    'Duolingo no cuenta. Bunpro y Anki, ahora.',
    'Lo que no repasas hoy, lo olvidas mañana. Así funciona la memoria.',
    'Japón no llega por desearlo. Llega por los repasos que haces hoy.',
    'Ya dejaste Anki una vez y perdiste meses. No otra vez.',
    'Cuando estés en Japón y no entiendas, vas a recordar este día.',
  ],
  rut: [
    'Haz ejercicio, o te empeorará la rodilla.',
    'La inactividad te quita años de vida. Hoy toca {rutina}.',
    'Sin entreno, el superávit no se convierte en músculo: se convierte en nada.',
    'Cada entreno que saltas es progreso que no vuelve.',
    'Tu rodilla necesita músculo alrededor. Hoy toca {rutina}.',
    '35 minutos. Es menos de lo que pasas en el teléfono.',
    'El músculo que no entrenas, lo pierdes. Hoy toca {rutina}.',
    'Existe el modo mínimo. No hay excusa para un día en cero.',
    'Tu cuerpo de dentro de 5 años se construye hoy. O se destruye hoy.',
  ],
  rut2: [
    'Sigues sin entrenar. Vas camino a un día en cero.',
    'Dos horas después y nada. Modo mínimo: 15 minutos. Ahora.',
    'Este día va a salir en el resumen que recibe tu persona de apoyo. Que sea uno bueno.',
    'Te estás fallando a ti mismo. Todavía estás a tiempo: {rutina}.',
    'Mañana te vas a arrepentir de esto. Hoy todavía no.',
  ],
  work: [
    '¿Cumpliste tu bloque de {inicio} a {fin}? Sin ingresos no hay tranquilidad.',
    'El dinero no se arregla solo. ¿Cumpliste tu bloque de {inicio} a {fin}?',
    'Cada día que pierdes dinero sin cambiar nada es una decisión. ¿Cumpliste tu bloque?',
  ],
  food: [
    '¿Seguiste el plan? Sin comida suficiente, el entreno no sirve de nada.',
    'Sin superávit no hay músculo. ¿Cómo comiste hoy?',
    'Entrenar y no comer es tirar el esfuerzo. ¿Seguiste el plan?',
  ],
  night: [
    'Si no duermes, mañana fallas el despertar. Rutina de noche y a la cama.',
    'Dormir tarde es lo que te rompió la constancia. 16 minutos y a dormir.',
    'Tu rodilla y tu espalda te lo cobran. Estira 16 minutos.',
    'Mañana a las {hora}. Si te acuestas ahora, llegas.',
    'El teléfono puede esperar. Tu sueño no.',
  ],
};
const ALARM_POOLS = ['wake', 'jp', 'rut', 'rut2', 'night'];
function sting(pool, date, r, vars) {
  const own = (r?.day?.phrases || []).filter(x => typeof x === 'string' && x.trim());
  const list = [...(STINGS[pool] || []), ...own];
  if (!list.length) return null;
  const day = Math.floor(new Date(date + 'T00:00:00Z') / 864e5), salt = [...pool].reduce((a, c) => a + c.charCodeAt(0), 0);
  return list[(day * 7 + salt) % list.length].replace(/\{(\w+)\}/g, (m, k) => vars?.[k] ?? m);
}
async function sendHealthPush(env, user, payload) {
  if (payload.pool) { // el texto de la frase del dia y, si se eligio, tipo alarma
    const r = await healthGet(env, user, 'reminder'), date = localParts(r?.tz).date, cfg = dayCfg(r);
    const t = r?.day?.harsh === false ? null : sting(payload.pool, date, r,
      { rutina: payload.rutina || 'tu rutina', hora: cfg.wake, inicio: cfg.workStart, fin: cfg.workEnd });
    payload = { ...payload, body: t || payload.body, alarm: r?.day?.alarm !== false && ALARM_POOLS.includes(payload.pool) };
  }
  const subs = (await healthGet(env, user, 'push')) || [];
  let sent = 0;
  for (const s of subs) if (await (s.fcm ? sendFcm(env, s.fcm, payload, s.v) : sendWebPush(env, s, payload))) sent++;
  return sent;
}

// ── Respuesta desde la notificacion: "¿Seguiste el plan?" Si / Mas o menos / No ──
// El enlace va firmado (HMAC de usuario + fecha), asi no hace falta la sesion: la
// app o el service worker lo llaman directo al tocar el boton.
async function quickSig(env, user, date) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('health-quick|' + (env.VAPID_PRIVATE_JWK || env.SUPABASE_KEY)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlBytes(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(user + '|' + date))).slice(0, 32);
}
async function checkinPush(env, user, date) {
  const s = await quickSig(env, user, date);
  return {
    title: '¿Seguiste el plan hoy?',
    body:  'Responde aquí mismo: Sí, Más o menos o No.',
    tag:   'health-checkin',
    url:   '/#hoy',
    kind:  'checkin', pool: 'food',
    actions: [{ action: 'si', title: 'Sí' }, { action: 'parcial', title: 'Más o menos' }, { action: 'no', title: 'No' }],
    quick: `https://habits-worker.efrenalejandro2010.workers.dev/health/quick?u=${encodeURIComponent(user)}&d=${date}&s=${s}`,
  };
}
async function quickLog(url, env) {
  const u = url.searchParams.get('u') || '', d = url.searchParams.get('d') || '', v = url.searchParams.get('v') || '';
  const h = url.searchParams.get('h');
  if (h) { // habito del dia (despertar, japones, trabajo, noche)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !DAY_KEYS.includes(h) || !['1', '0'].includes(v)) return err('bad request');
    if (url.searchParams.get('s') !== await quickSig(env, u, d)) return err('firma invalida', 403);
    const val = v === '0' ? 0 : h === 'wake' ? localParts((await healthGet(env, u, 'reminder'))?.tz).hhmm : 1;
    await dayMark(env, u, d, h, val);
    const label = v === '0' ? 'Registrado. Mañana otra vez.' : { wake: `Despierto a las ${val}. A por el día.`, jp: 'Japonés ✓', work: 'Trabajo ✓', night: 'Rutina de noche ✓ A dormir.' }[h];
    return json({ ok: true, label });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !['si', 'parcial', 'no'].includes(v)) return err('bad request');
  if (url.searchParams.get('s') !== await quickSig(env, u, d)) return err('firma invalida', 403);
  const n = await healthGet(env, u, 'nutrition');
  const p = n?.profiles?.[n.activeProfile];
  const day = (p?.days || []).find(x => x.id === p.activeDay) || (p?.days || [])[0];
  const base = day ? { dayId: day.id, label: day.label, profile: p.name } : {};
  await healthDay(env, u, 'nutrition_log', d, v === 'no' ? { skipped: true } : v === 'parcial' ? { ...base, partial: true } : base);
  return json({ ok: true, label: v === 'no' ? 'No seguiste el plan' : v === 'parcial' ? 'Más o menos' : 'Plan cumplido' });
}
// Segundo aviso, 2 h despues, si la rutina sigue sin hacerse
function rutinaPush2(rutina, date) {
  const name = rutina?.date !== date && rutina?.nextDay?.name ? rutina.nextDay.name : rutina?.name;
  const set = new Set(rutina?.history || []);
  let n = 0;
  for (let d = shiftISO(date, -1); set.has(d); d = shiftISO(d, -1)) n++;
  return {
    title: `${name || 'Tu rutina'} te espera`,
    body:  n ? `Llevas ${n} ${n === 1 ? 'día' : 'días'} seguidos. Aunque sea el modo mínimo (10 min): cuenta.` : 'Aunque sea el modo mínimo (10 min): cuenta para la racha.',
    tag:   'health-rutina',
    url:   '/#rutina', pool: 'rut2', rutina: name,
  };
}
const addMin = (hhmm, m) => { const t = (+hhmm.slice(0, 2) * 60 + +hhmm.slice(3) + m) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

// El aviso nombra la rutina que toca hoy: en un dia nuevo, la siguiente de la
// alternancia (nextDay, la guarda Rutina) o la misma de antes
function rutinaPush(rutina, date) {
  const name = rutina?.date !== date && rutina?.nextDay?.name ? rutina.nextDay.name : rutina?.name;
  return {
    title: 'Rutina de hoy',
    body:  `${name || 'Tu rutina'} te espera. No pierdas la racha.`,
    tag:   'health-rutina',
    url:   '/#rutina', pool: 'rut', rutina: name,
  };
}

// ── Health: mi dia (habitos no negociables) ──────────────────────────────────
// daylog: { 'YYYY-MM-DD': { wake: 'HH:MM', jp: 1, work: 1, night: 1 } } (0 = no lo hizo).
// Entrenar sale de rutina.history (o el dia de descanso) y comer de nutrition_log.
const DAY_KEYS = ['wake', 'jp', 'work', 'night'];
const DEF_DAY = { wake: '08:00', jp: '08:10', workStart: '09:30', workEnd: '13:00', night: '22:30', workDays: [1, 2, 3, 4, 5] };
const dayCfg = r => ({ ...DEF_DAY, ...(r?.day || {}) });
const dayOn = r => (r?.day ? r.day.on !== false : !!r?.enabled);
const wakeOk = (t, target) => typeof t === 'string' && t <= addMin(target, 60);
async function dayMark(env, user, date, key, val) {
  await healthDay(env, user, 'daylog', date, { [key]: val }, true);
}
async function dayData(env, user) {
  const [log, rutina, nlog, r] = await Promise.all(['daylog', 'rutina', 'nutrition_log', 'reminder'].map(k => healthGet(env, user, k)));
  return { log: log || {}, rutina, nlog: nlog || {}, cfg: dayCfg(r) };
}
// Lo mismo que el anillo de Hoy: cuantos de los 6 se cumplieron ese dia
function dayParts(date, { log, rutina, nlog, cfg }) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay(), d = log[date] || {};
  const rest = Number.isInteger(rutina?.prefs?.restDay) && rutina.prefs.restDay === dow;
  return {
    wake: wakeOk(d.wake, cfg.wake), jp: !!d.jp, rut: rest || (rutina?.history || []).includes(date),
    work: !cfg.workDays.includes(dow) || !!d.work, food: !!nlog[date], night: !!d.night,
  };
}
const dayScore = (date, data) => { const v = Object.values(dayParts(date, data)); return v.filter(Boolean).length / v.length; };
async function quickUrl(env, user, date, h) {
  return `https://habits-worker.efrenalejandro2010.workers.dev/health/quick?u=${encodeURIComponent(user)}&d=${date}&s=${await quickSig(env, user, date)}${h ? '&h=' + h : ''}`;
}
async function habitPush(env, user, date, h, cfg) {
  const P = {
    wake:  { title: 'Buenos días ☀️', body: `Son las ${cfg.wake}. Toca "Ya estoy despierto" y arranca: japonés → entreno → desayuno.`, actions: [{ action: '1', title: 'Ya estoy despierto' }], url: '/#hoy' },
    jp:    { title: 'Japonés 🇯🇵', body: 'Bunpro + Anki antes de entrenar. Mínimo: 10 minutos.', actions: [{ action: '1', title: 'Hecho' }], url: '/#hoy' },
    work:  { title: 'Bloque de trabajo', body: `¿Cumpliste tu bloque de ${cfg.workStart} a ${cfg.workEnd}?`, actions: [{ action: '1', title: 'Sí' }, { action: '0', title: 'No' }], url: '/#hoy' },
    night: { title: 'Rutina de noche 🌙', body: '16 min para soltar el cuerpo y a dormir. Mínimo: 9 min.', actions: [{ action: '1', title: 'Hecha' }], url: '/#rutina' },
  }[h];
  return { ...P, tag: 'health-' + h, kind: 'habit', pool: h, quick: await quickUrl(env, user, date, h) };
}

// ── Health: tu novia por Telegram (resumen semanal y aviso si fallas 2 dias) ──
async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return null; }
}
// Clave del webhook: los primeros 32 hex del SHA-256 del token (el despliegue la calcula igual)
async function tgSecret(env) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN || ''));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function tgBotName(env) {
  let n = await env.PUSH_KV.get('tg:botname');
  if (!n) { n = (await tg(env, 'getMe', {}))?.result?.username || ''; if (n) await env.PUSH_KV.put('tg:botname', n, { expirationTtl: 86400 }); }
  return n;
}
async function tgWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await tgSecret(env)) return err('no', 403);
  const msg = (await request.json().catch(() => ({})))?.message;
  const text = msg?.text || '', chat = msg?.chat?.id;
  if (!chat) return json({ ok: true });
  const code = (text.match(/^\/start\s+([a-f0-9]{16})$/) || [])[1];
  const user = code && await env.PUSH_KV.get('tglink:' + code);
  if (!user) {
    await tg(env, 'sendMessage', { chat_id: chat, text: 'Hola 👋 Para recibir el progreso de alguien, abre el enlace que te comparte desde su app Health.' });
    return json({ ok: true });
  }
  await env.PUSH_KV.delete('tglink:' + code);
  await healthSet(env, user, 'partner_tg', { chat, name: msg.from?.first_name || '' });
  await tg(env, 'sendMessage', { chat_id: chat, text: `Listo ✅ Desde ahora te llega el resumen semanal de ${await userName(env, user)} y un aviso si falla 2 días seguidos. Gracias por ayudarle 💪` });
  return json({ ok: true });
}
async function userName(env, user) {
  const n = await healthGet(env, user, 'nutrition');
  return n?.profiles?.[n.activeProfile]?.name || user.split('@')[0];
}
async function partnerWeekly(env, user, today) {
  const data = await dayData(env, user), days = [...Array(7)].map((_, i) => shiftISO(today, i - 7)); // los 7 dias anteriores
  const P = days.map(d => dayParts(d, data)), n = k => P.filter(x => x[k]).length;
  const workDays = days.filter(d => data.cfg.workDays.includes(new Date(d + 'T00:00:00Z').getUTCDay())).length;
  const full = days.filter(d => dayScore(d, data) === 1).length;
  const fd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const comp = ((await healthGet(env, user, 'bodymetrics'))?.bodyComp || []).filter(e => e.weight).sort((a, b) => a.date.localeCompare(b.date));
  const last = comp[comp.length - 1], prev = last && [...comp].reverse().find(e => e.date <= shiftISO(last.date, -7));
  const lines = [
    `📊 Semana de ${await userName(env, user)} (${fd(days[0])} – ${fd(days[6])})`,
    `✅ Días completos: ${full}/7`,
    `⏰ Se levantó a tiempo: ${n('wake')}/7`,
    `🇯🇵 Japonés: ${n('jp')}/7 · 🏋️ Entreno: ${days.filter(d => (data.rutina?.history || []).includes(d)).length}/${7 - days.filter(d => data.rutina?.prefs?.restDay === new Date(d + 'T00:00:00Z').getUTCDay()).length}`,
    `💼 Trabajo: ${P.filter((x, i) => x.work && data.cfg.workDays.includes(new Date(days[i] + 'T00:00:00Z').getUTCDay())).length}/${workDays} · 🍽 Comida: ${n('food')}/7`,
    `🌙 Rutina de noche: ${n('night')}/7`,
  ];
  if (last) lines.push(`⚖️ Peso: ${last.weight} kg${prev ? ` (${last.weight - prev.weight >= 0 ? '+' : ''}${(last.weight - prev.weight).toFixed(1)} en la semana)` : ''}`);
  lines.push(full >= 5 ? '\nGran semana. Díselo 🙌' : full >= 3 ? '\nVa construyendo. Un empujón ayuda.' : '\nSemana floja: tu apoyo cuenta mucho esta semana.');
  return lines.join('\n');
}
async function partnerAlert(env, user, today) {
  const data = await dayData(env, user), y = shiftISO(today, -1), yy = shiftISO(today, -2);
  if (dayScore(y, data) >= 0.5 || dayScore(yy, data) >= 0.5) return null;
  const v = Object.values(dayParts(y, data)).filter(Boolean).length;
  return `⚠️ ${await userName(env, user)} lleva 2 días seguidos sin cumplir sus hábitos (ayer: ${v} de 6). Un mensaje tuyo puede hacer la diferencia hoy 💪`;
}

// ── Health: vinculo con Habits ────────────────────────────────────────────────
// Al completar la rutina se marca el habito vinculado (siempre del mismo usuario).
async function markLinkedHabit(env, user, date) {
  const link = await healthGet(env, user, 'habit_link');
  if (!link?.habit_id) return;
  const h = await env.DB.prepare('SELECT type, target_value FROM habits WHERE id = ? AND user_id = ? AND active = 1')
    .bind(link.habit_id, user).first();
  if (!h) return;
  const value = h.type === 'count' ? (h.target_value || 1) : 1;
  await env.DB.prepare(
    `INSERT INTO completions (id,user_id,habit_id,date,value,note,created_at) VALUES (?,?,?,?,?,NULL,?)
     ON CONFLICT(habit_id, date) DO UPDATE SET value = MAX(value, excluded.value)`
  ).bind(uuid(), user, link.habit_id, date, value, Math.floor(Date.now() / 1000)).run();
}

// ── Health: resumen de los ultimos 7 dias ────────────────────────────────────
function shiftISO(dateISO, days) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function weeklySummary(env, user, today) {
  const from = shiftISO(today, -6);
  const inWeek = d => d >= from && d <= today;
  const rutina = await healthGet(env, user, 'rutina');
  const rutinaDays = (rutina?.history || []).filter(inWeek).length;
  const nlog = (await healthGet(env, user, 'nutrition_log')) || {};
  const planDays = Object.entries(nlog).filter(([d, v]) => inWeek(d) && v && !v.skipped).length;
  let weight = null;
  const comp = ((await healthGet(env, user, 'bodymetrics'))?.bodyComp || [])
    .filter(e => e.weight).sort((a, b) => a.date.localeCompare(b.date));
  const last = comp[comp.length - 1];
  if (last) {
    const prev = [...comp].reverse().find(e => e.date <= shiftISO(last.date, -7));
    weight = { last: last.weight, delta: prev ? +(last.weight - prev.weight).toFixed(1) : null };
  }
  const parts = [`Rutina ${rutinaDays}/7`, `Plan ${planDays}/7`];
  if (weight) parts.push(weight.delta == null ? `Peso ${weight.last} kg`
    : `Peso ${weight.delta > 0 ? '+' : ''}${weight.delta} kg (${weight.last})`);
  return {
    title: 'Tu semana en Health',
    body:  parts.join(' · '),
    tag:   'health-weekly',
    url:   '/#resumen',
  };
}

// Llamada a la API de USDA con la llave del worker. Los detalles de un alimento
// no cambian: se guardan un mes en la cache de Cloudflare.
async function usda(env, p, cacheable = false) {
  const cacheKey = new Request('https://usda.cache' + p);
  if (cacheable) { const hit = await caches.default.match(cacheKey); if (hit) return json(await hit.json()); }
  const sep = p.includes('?') ? (p.endsWith('?') ? '' : '&') : '?';
  const r = await fetch(`https://api.nal.usda.gov/fdc/v1${p}${sep}api_key=${env.USDA_API_KEY || 'DEMO_KEY'}`);
  if (!r.ok) return err(`USDA ${r.status}`, r.status === 429 ? 429 : 502);
  const data = await r.json();
  if (cacheable) await caches.default.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'max-age=2592000' } }));
  return json(data);
}

async function handleHealth(path, request, env) {
  const method = request.method;
  if (path === '/health/vapid' && method === 'GET') return json({ key: env.VAPID_PUBLIC || null, fcm: !!serviceAccount(env) });
  if (path === '/health/quick' && method === 'POST') return quickLog(new URL(request.url), env);
  if (path === '/health/tg' && method === 'POST') return tgWebhook(request, env);
  const user = await healthUser(request, env);
  if (!user) return err('Sesion invalida', 401);

  if (path === '/health/me' && method === 'GET') return json({ email: user });
  // Mi dia: marcar despertar, japones, trabajo y rutina de noche
  if (path === '/health/day' && method === 'GET') return json({ data: (await healthGet(env, user, 'daylog')) || {} });
  if (path === '/health/day' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.date || '') || !DAY_KEYS.includes(b.key)) return err('bad request');
    const val = b.key === 'wake' ? (typeof b.val === 'string' && /^\d{2}:\d{2}$/.test(b.val) ? b.val : 0) : (b.val ? 1 : 0);
    await dayMark(env, user, b.date, b.key, val);
    return json({ ok: true });
  }
  // Comida de un dia (Si / Mas o menos / No) sin reescribir todo el registro
  if (path === '/health/nutrition_log/day' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.date || '')) return err('bad request');
    await healthDay(env, user, 'nutrition_log', b.date, b.entry && typeof b.entry === 'object' ? b.entry : null);
    return json({ ok: true });
  }
  // Tu novia por Telegram
  if (path === '/health/partner' && method === 'GET') {
    const p = await healthGet(env, user, 'partner_tg');
    return json({ ready: !!env.TELEGRAM_BOT_TOKEN, linked: !!p, name: p?.name || '' });
  }
  if (path === '/health/partner/link' && method === 'POST') {
    const bot = await tgBotName(env);
    if (!bot) return err('Telegram aun no esta configurado', 503);
    const code = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    await env.PUSH_KV.put('tglink:' + code, user, { expirationTtl: 7 * 86400 });
    return json({ url: `https://t.me/${bot}?start=${code}` });
  }
  if (path === '/health/partner' && method === 'DELETE') { await healthSet(env, user, 'partner_tg', null); return json({ ok: true }); }
  if (path === '/health/partner/test' && method === 'POST') {
    const p = await healthGet(env, user, 'partner_tg');
    if (!p) return err('Sin Telegram vinculado', 404);
    const r = await healthGet(env, user, 'reminder');
    const res = await tg(env, 'sendMessage', { chat_id: p.chat, text: '(Prueba) ' + await partnerWeekly(env, user, localParts(r?.tz).date) });
    return json({ ok: !!res?.ok });
  }
  // USDA (buscar alimentos y micronutrientes): la llave es del worker (secret
  // USDA_API_KEY), asi nadie la pone a mano. Solo para cuentas con sesion.
  if (path === '/health/usda/search' && method === 'GET') {
    const q = (new URL(request.url).searchParams.get('q') || '').slice(0, 100);
    if (!q.trim()) return err('falta q');
    return usda(env, `/foods/search?query=${encodeURIComponent(q)}&dataType=Foundation,SR%20Legacy&pageSize=10`);
  }
  const fm = path.match(/^\/health\/usda\/food\/(\d{1,10})$/);
  if (fm && method === 'GET') return usda(env, `/food/${fm[1]}?`, true);
  // Fotos de progreso: una por mes, en KV (privadas por cuenta)
  if (path === '/health/photos' && method === 'GET') {
    const { keys } = await env.PUSH_KV.list({ prefix: `photo:${user}|` });
    return json({ months: keys.map(k => k.name.split('|').pop()) });
  }
  if (path === '/health/photo') {
    const m = new URL(request.url).searchParams.get('m') || '';
    if (!/^\d{4}-\d{2}$/.test(m)) return err('mes invalido');
    const key = `photo:${user}|${m}`;
    if (method === 'GET') return json({ data: await env.PUSH_KV.get(key) });
    if (method === 'DELETE') { await env.PUSH_KV.delete(key); return json({ ok: true }); }
    if (method === 'PUT') {
      const { data } = await request.json().catch(() => ({}));
      if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,') || data.length > 3_000_000) return err('foto invalida');
      await env.PUSH_KV.put(key, data);
      return json({ ok: true });
    }
  }
  if (path === '/health/push' && method === 'POST') {
    // Web Push ({endpoint, keys}) o la app Android ({fcm: token})
    const sub = await request.json();
    if (!sub?.endpoint && typeof sub?.fcm !== 'string') return err('subscription required');
    const subs = ((await healthGet(env, user, 'push')) || []).filter(s => sub.fcm ? s.fcm !== sub.fcm : s.endpoint !== sub.endpoint);
    subs.push(sub);
    await healthSet(env, user, 'push', subs.slice(-5)); // un par de dispositivos; descarta los mas viejos
    return json({ ok: true });
  }
  if (path === '/health/test-push' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const r = await healthGet(env, user, 'reminder');
    const date = localParts(r?.tz).date;
    const payload = b?.kind === 'weekly' ? await weeklySummary(env, user, date)
      : b?.kind === 'checkin' ? await checkinPush(env, user, date)
      : DAY_KEYS.includes(b?.kind) ? await habitPush(env, user, date, b.kind, dayCfg(r))
      : rutinaPush(await healthGet(env, user, 'rutina'), date);
    return json({ sent: await sendHealthPush(env, user, payload), payload });
  }
  // Habitos del usuario que se pueden vincular a la rutina
  if (path === '/health/habits' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, emoji FROM habits WHERE active = 1 AND user_id = ? ORDER BY sort_order, created_at'
    ).bind(user).all();
    return json({ habits: results || [], link: await healthGet(env, user, 'habit_link') });
  }
  if (path === '/health/habits' && method === 'POST') { // crea "Rutina de estiramiento" en Habits
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO habits (id,user_id,name,description,type,target_value,target_unit,frequency,color,emoji,sort_order,created_at)
       VALUES (?,?,?,?,'binary',1,'veces','daily','mint','🧘',0,?)`
    ).bind(id, user, 'Rutina de estiramiento', 'Se marca sola al completar la rutina en Health',
      Math.floor(Date.now() / 1000)).run();
    return json({ habit: { id } }, 201);
  }
  if (path === '/health/habit-link' && method === 'PUT') {
    const b = await request.json();
    if (b?.habit_id) {
      const own = await env.DB.prepare('SELECT 1 FROM habits WHERE id = ? AND user_id = ?').bind(b.habit_id, user).first();
      if (!own) return err('Habito no encontrado', 404);
    }
    await healthSet(env, user, 'habit_link', b?.habit_id ? { habit_id: b.habit_id } : null);
    const rutina = await healthGet(env, user, 'rutina');
    if (b?.habit_id && b.today && rutina?.history?.includes(b.today)) await markLinkedHabit(env, user, b.today);
    return json({ ok: true });
  }
  if (path === '/health/rutina' && method === 'PUT') {
    const next = await request.json();
    const prev = await healthGet(env, user, 'rutina');
    await healthSet(env, user, 'rutina', next);
    const before = new Set(prev?.history || []);
    for (const d of next?.history || []) if (!before.has(d)) await markLinkedHabit(env, user, d);
    return json({ ok: true });
  }
  const m = path.match(/^\/health\/(rutina|reminder|nutrition_log|nutrition|bodymetrics)$/);
  if (m && method === 'GET') return json({ data: await healthGet(env, user, m[1]) });
  if (m && method === 'PUT') {
    await healthSet(env, user, m[1], await request.json());
    return json({ ok: true });
  }
  return err('Not found', 404);
}

async function dispatchHealthReminder(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM health_kv WHERE k LIKE '%|reminder'").all();
  for (const row of results || []) {
    const user = row.k.slice(0, -'|reminder'.length);
    let r; try { r = JSON.parse(row.v); } catch { continue; }
    if (!r?.time) continue;
    const { date, hhmm } = localParts(r.tz);
    // Pregunta de la noche (solo si ese dia aun no se registro la comida)
    if (r.checkin && hhmm === (r.checkinTime || '21:30') && (await healthGet(env, user, 'checkin_sent')) !== date) {
      await healthSet(env, user, 'checkin_sent', date);
      const nlog = (await healthGet(env, user, 'nutrition_log')) || {};
      if (!nlog[date]) await sendHealthPush(env, user, await checkinPush(env, user, date));
    }
    // Mi dia: despertar, japones, fin del bloque de trabajo y rutina de noche (si aun no se marcaron)
    const cfg = dayCfg(r), dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dayOn(r)) for (const [h, at] of [['wake', cfg.wake], ['jp', cfg.jp], ['work', cfg.workEnd], ['night', cfg.night]]) {
      if (hhmm !== at || (h === 'work' && !cfg.workDays.includes(dow))) continue;
      if ((await healthGet(env, user, 'sent_' + h)) === date) continue;
      await healthSet(env, user, 'sent_' + h, date);
      if (!(await healthGet(env, user, 'daylog'))?.[date]?.[h]) await sendHealthPush(env, user, await habitPush(env, user, date, h, cfg));
    }
    // Tu novia por Telegram: aviso a las 12:00 si ayer y anteayer fallaste; resumen los lunes 10:00
    if (hhmm === '12:00' || (hhmm === '10:00' && dow === 1)) {
      const p = await healthGet(env, user, 'partner_tg');
      if (p) {
        if (hhmm === '12:00' && (await healthGet(env, user, 'tg_alert')) !== date) {
          await healthSet(env, user, 'tg_alert', date);
          const t = await partnerAlert(env, user, date);
          if (t) await tg(env, 'sendMessage', { chat_id: p.chat, text: t });
        }
        if (hhmm === '10:00' && (await healthGet(env, user, 'tg_weekly')) !== date) {
          await healthSet(env, user, 'tg_weekly', date);
          await tg(env, 'sendMessage', { chat_id: p.chat, text: await partnerWeekly(env, user, date) });
        }
      }
    }
    // Dia de descanso de la semana (Rutina > Opciones): sin avisos de rutina
    const restDay = async () => { const ru = await healthGet(env, user, 'rutina'); const d = ru?.prefs?.restDay;
      return Number.isInteger(d) && d >= 0 && new Date(date + 'T00:00:00Z').getUTCDay() === d; };
    // Segundo aviso de la rutina, 2 h despues, si sigue sin hacerse
    if (r.enabled && hhmm === addMin(r.time, 120) && !(await restDay()) && (await healthGet(env, user, 'reminder2_sent')) !== date) {
      await healthSet(env, user, 'reminder2_sent', date);
      const rutina = await healthGet(env, user, 'rutina');
      if (!rutina?.history?.includes(date)) await sendHealthPush(env, user, rutinaPush2(rutina, date));
    }
    if (hhmm !== r.time) continue;
    if (r.enabled && (await healthGet(env, user, 'reminder_sent')) !== date && !(await restDay())) {
      await healthSet(env, user, 'reminder_sent', date);
      const rutina = await healthGet(env, user, 'rutina');
      if (!rutina?.history?.includes(date)) await sendHealthPush(env, user, rutinaPush(rutina, date)); // si ya la hizo, no avisa
    }
    // Resumen semanal: los domingos a la misma hora del recordatorio
    const sunday = new Date(date + 'T00:00:00Z').getUTCDay() === 0;
    if (r.weekly && sunday && (await healthGet(env, user, 'weekly_sent')) !== date) {
      await healthSet(env, user, 'weekly_sent', date);
      await sendHealthPush(env, user, await weeklySummary(env, user, date));
    }
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
  try { await env.DB.prepare("ALTER TABLE habits ADD COLUMN paused INTEGER NOT NULL DEFAULT 0").run(); } catch (_) {}
  try { await env.DB.prepare("ALTER TABLE habits ADD COLUMN paused_at TEXT").run(); } catch (_) {}
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS health_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
  // Health antes era de un solo usuario: sus datos sin duenio pasan a HEALTH_OWNER
  if (env.HEALTH_OWNER) {
    await env.DB.prepare("UPDATE OR IGNORE health_kv SET k = ? || '|' || k WHERE k NOT LIKE '%|%'")
      .bind(env.HEALTH_OWNER.toLowerCase()).run();
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function getHabits(request, env, uid) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM habits WHERE active = 1 AND user_id = ? ORDER BY sort_order, created_at`
  ).bind(uid).all();

  const url      = new URL(request.url);
  const todayISO = url.searchParams.get('today') || isoUTC(new Date());

  const { results: comps } = await env.DB.prepare(
    `SELECT habit_id, date, value FROM completions WHERE user_id = ? AND value > 0`
  ).bind(uid).all();

  // value map per habit so count habits only count as done when they reach target
  const valByHabit = {};
  for (const c of comps) {
    (valByHabit[c.habit_id] ||= new Map()).set(c.date, c.value);
  }
  for (const h of results) {
    const vals = valByHabit[h.id] || new Map();
    const doneSet = new Set();
    for (const [date, value] of vals) {
      if (habitDone(h, value)) doneSet.add(date);
    }
    h.streak        = calcStreak(h, doneSet, todayISO);
    h.record_streak = calcRecord(h, doneSet, todayISO);
    h.rate30        = calcRate(h, doneSet, todayISO, 30);
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
                   'frequency_days','frequency_every','color','emoji','reminder_time','tz','sort_order','paused','paused_at'];
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
      `INSERT OR REPLACE INTO completions (id,user_id,habit_id,date,value,note,created_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(id, uid, habit_id, date, value, b.note || null, now).run();
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
  // Preserve an existing note when the caller (e.g. a count increment) omits it.
  let note = b.note;
  if (note === undefined) {
    const ex = await env.DB.prepare(
      `SELECT note FROM completions WHERE user_id = ? AND habit_id = ? AND date = ?`
    ).bind(uid, habit_id, date).first();
    note = ex?.note ?? null;
  }
  const id  = uuid();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO completions (id,user_id,habit_id,date,value,note,created_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, uid, habit_id, date, value, note, now).run();
  return json({ ok: true, value });
}

async function getStats(request, env, uid) {
  const url   = new URL(request.url);
  const month = url.searchParams.get('month');
  if (!month) return err('month required');

  const from = `${month}-01`;
  const to   = `${month}-31`;

  const { results: habits } = await env.DB.prepare(
    `SELECT id, name, type, target_value, frequency, frequency_days, frequency_every, color, created_at, paused, paused_at FROM habits WHERE active = 1 AND user_id = ?`
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
    const due  = habits.filter(h => activeDueOn(h, date));
    const done = due.filter(h => habitDone(h, compMap[h.id]?.[date])).length;
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
    // Health usa el token de Supabase del usuario, no el TOKEN compartido
    const healthPath = new URL(request.url).pathname.replace(/\/$/, '');
    if (healthPath.startsWith('/health/')) {
      try {
        await migrate(env);
        return await handleHealth(healthPath, request, env);
      } catch (e) {
        return err(e.message, 500);
      }
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
    try { await dispatchHealthReminder(env); } catch (_) {}
  },
};
