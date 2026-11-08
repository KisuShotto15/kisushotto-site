// health/auth.js — cuentas de Health con el mismo Supabase que Portfolio:
// login por codigo al correo (OTP de GoTrue, sin SDK) y passkey. La sesion vive
// en localStorage (compartido por el shell y las pestanas, mismo origen) y se
// pide volver a entrar cada 30 dias. La URL y la publishable key son publicas
// por diseno; el worker valida cada token contra Supabase.

export const SB_URL = 'https://fcrqrfpjpuscorbogjho.supabase.co';
export const SB_KEY = 'sb_publishable_1ru1s3pT8wJ75GEKa2ag5A_jlz0y1GQ';
const MAX_SESSION_MS = 30 * 24 * 3600 * 1000;
// Datos locales de un usuario que no deben pasar a otro al cambiar de cuenta
const USER_LOCAL_KEYS = ['health_rutina_v1', 'nutrition_v1', 'body_metrics_v1',
  'nutrition_v1_dirty', 'body_metrics_v1_dirty', 'health_nlog_pending'];

const get = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const del = k => { try { localStorage.removeItem(k); } catch {} };

export function currentEmail() { return get('hx_email'); }

export function hasSession() {
  if (!get('hx_rt')) return false;
  const since = +get('hx_login_at') || 0;
  if (Date.now() - since > MAX_SESSION_MS) { clearSession(); return false; }
  return true;
}

function setSession(j, isLogin) {
  const email = j.user?.email?.toLowerCase();
  const prev = get('hx_email');
  if (email && prev && email !== prev) USER_LOCAL_KEYS.forEach(del); // cambio de cuenta
  if (j.access_token) set('hx_at', j.access_token);
  if (j.refresh_token) set('hx_rt', j.refresh_token);
  if (email) set('hx_email', email);
  if (isLogin) set('hx_login_at', String(Date.now()));
}

export function clearSession() { ['hx_at', 'hx_rt', 'hx_email', 'hx_login_at'].forEach(del); }

export function logout() {
  clearSession();
  USER_LOCAL_KEYS.forEach(del);
}

// Single-flight: GoTrue rota el refresh token en cada uso; dos refresh en
// paralelo con el mismo token pueden invalidar la sesion.
let refreshing = null;
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rt = get('hx_rt'); if (!rt) return false;
    try {
      const r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (r.ok) { setSession(await r.json(), false); return true; }
      if (r.status < 500) clearSession(); // token rechazado: la sesion ya no vale
      return false;
    } catch { return false; }
  })();
  refreshing.finally(() => { refreshing = null; });
  return refreshing;
}

// fetch con el token del usuario; si el servidor dice 401, renueva y reintenta una vez
export async function authFetch(url, init = {}) {
  const mk = () => ({ ...(init.headers || {}), Authorization: 'Bearer ' + get('hx_at') });
  let r = await fetch(url, { ...init, headers: mk() });
  if (r.status === 401 && await refresh()) r = await fetch(url, { ...init, headers: mk() });
  if (r.status === 401 && window.parent !== window) window.parent.postMessage({ type: 'health:login' }, location.origin);
  return r;
}

// ── Codigo por correo ──────────────────────────────────────────────────────
export async function requestCode(email) {
  try {
    const r = await fetch(SB_URL + '/auth/v1/otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
      body: JSON.stringify({ email, create_user: false }),
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, code: j.error_code || j.code || String(r.status) };
  } catch { return { ok: false, code: 'network' }; }
}

export async function verifyCode(email, token) {
  try {
    const r = await fetch(SB_URL + '/auth/v1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
      body: JSON.stringify({ email, token, type: 'email' }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j.access_token) return false;
    setSession(j, true);
    return true;
  } catch { return false; }
}

// ── Passkeys (WebAuthn de Supabase) ────────────────────────────────────────
const b64uToBuf = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
};
const bufToB64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function credToJson(cred, kind) {
  if (typeof cred.toJSON === 'function') return cred.toJSON();
  const resp = cred.response;
  const out = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() || {} };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  out.response = kind === 'create'
    ? { clientDataJSON: bufToB64u(resp.clientDataJSON), attestationObject: bufToB64u(resp.attestationObject), transports: resp.getTransports?.() }
    : { clientDataJSON: bufToB64u(resp.clientDataJSON), authenticatorData: bufToB64u(resp.authenticatorData),
        signature: bufToB64u(resp.signature), userHandle: resp.userHandle ? bufToB64u(resp.userHandle) : null };
  return out;
}

async function sbAuthed(path, method, body) {
  const mk = () => ({ 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + get('hx_at') });
  let r = await fetch(SB_URL + '/auth/v1' + path, { method, headers: mk(), body });
  if (r.status === 401 && await refresh()) r = await fetch(SB_URL + '/auth/v1' + path, { method, headers: mk(), body });
  return r;
}

// La passkey solo funciona si el RP ID configurado en Supabase es este dominio
// o uno padre (p. ej. kisushotto.com). Con portfolio.kisushotto.com no sirve aqui.
let pkCheck = null;
export function passkeysUsable() {
  if (!window.PublicKeyCredential || !navigator.credentials) return Promise.resolve(false);
  if (!pkCheck) pkCheck = fetch(SB_URL + '/auth/v1/passkeys/authentication/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY }, body: '{}',
  }).then(r => r.ok ? r.json() : null).then(j => {
    const rp = j?.options?.rpId; const h = location.hostname;
    return !!rp && (h === rp || h.endsWith('.' + rp));
  }).catch(() => false);
  return pkCheck;
}

export async function passkeyLogin() {
  const r = await fetch(SB_URL + '/auth/v1/passkeys/authentication/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY }, body: '{}',
  });
  if (!r.ok) throw new Error('Passkeys no disponibles ahora');
  const j = await r.json(); const o = j.options;
  o.challenge = b64uToBuf(o.challenge);
  (o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id); });
  const cred = await navigator.credentials.get({ publicKey: o });
  const v = await fetch(SB_URL + '/auth/v1/passkeys/authentication/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
    body: JSON.stringify({ challenge_id: j.challenge_id, credential: credToJson(cred, 'get') }),
  });
  const t = await v.json().catch(() => ({}));
  if (!v.ok || !t.access_token) throw new Error('Passkey rechazada' + (t.msg ? ': ' + t.msg : ''));
  setSession(t, true);
}

export async function passkeyRegister() {
  const r = await sbAuthed('/passkeys/registration/options', 'POST', '{}');
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error('No se pudo iniciar: ' + (e.msg || e.error_code || r.status)); }
  const j = await r.json(); const o = j.options;
  o.challenge = b64uToBuf(o.challenge);
  o.user.id = b64uToBuf(o.user.id);
  (o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id); });
  const cred = await navigator.credentials.create({ publicKey: o });
  const v = await sbAuthed('/passkeys/registration/verify', 'POST', JSON.stringify({ challenge_id: j.challenge_id, credential: credToJson(cred, 'create') }));
  if (!v.ok) { const t = await v.json().catch(() => ({})); throw new Error('Verificación falló: ' + (t.msg || t.error_code || v.status)); }
}

export async function listPasskeys() {
  const r = await sbAuthed('/passkeys/', 'GET').catch(() => null);
  if (!r?.ok) return [];
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

export async function deletePasskey(id) {
  const r = await sbAuthed('/passkeys/' + id, 'DELETE');
  return r.ok;
}
