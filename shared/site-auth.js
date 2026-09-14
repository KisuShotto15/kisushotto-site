// Sesion unica para todas las apps del sitio: el JWT que emite /api/auth/login.
//
// Cada app tenia antes su propia idea de "quien eres": un token publicado en el
// bundle, un email escrito a mano, o nada. Esto lo reemplaza por una sola cuenta,
// la misma del P2P Monitor y del diario de trading.
//
// Uso tipico, al arrancar la app:
//
//   import { requireSession } from '../shared/site-auth.js';
//   const session = await requireSession({ app: 'Planner', prefix: 'planner' });
//   // ...a partir de aqui hay sesion segura; session.token() para las peticiones
//
// requireSession no resuelve hasta que hay sesion: si no la hay, pinta la pantalla
// de login y espera. Asi la app nunca arranca a medias sin identidad.

const AUTH_BASE = 'https://kisushotto-site.vercel.app';

export function makeSession(prefix) {
  const kTok = prefix + '_jwt';
  const kMail = prefix + '_email';
  return {
    token: () => localStorage.getItem(kTok) || '',
    email: () => localStorage.getItem(kMail) || '',
    save(token, email) {
      localStorage.setItem(kTok, token);
      localStorage.setItem(kMail, email);
    },
    clear() {
      localStorage.removeItem(kTok);
      localStorage.removeItem(kMail);
    },
  };
}

async function login(email, password) {
  const res = await fetch(AUTH_BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'Error ' + res.status);
    e.data = data;
    throw e;
  }
  return data.token;
}

const CSS = `
.ks-login { position: fixed; inset: 0; z-index: 99999; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: #08080c; color: #e2e2ed;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
.ks-login-card { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 12px; }
.ks-login-eyebrow { font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: #6b6b85; margin: 0; }
.ks-login-card h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 6px; }
.ks-login-card input { width: 100%; padding: 12px 14px; border-radius: 10px; font-size: 1rem;
  background: #141419; border: 1px solid #26263a; color: #e2e2ed; font-family: inherit; }
.ks-login-card input:focus { outline: 2px solid #6366f1; outline-offset: 1px; border-color: transparent; }
.ks-login-card button { width: 100%; padding: 12px 14px; border-radius: 10px; font-size: 0.95rem;
  font-weight: 600; border: none; cursor: pointer; background: #6366f1; color: #fff;
  font-family: inherit; }
.ks-login-card button:disabled { opacity: 0.55; cursor: default; }
.ks-login-msg { min-height: 1.2em; font-size: 0.85rem; margin: 0; color: #f87171; }
.ks-login-foot { font-size: 0.8rem; color: #6b6b85; margin: 4px 0 0; }
.ks-login-foot a { color: #8b8bb0; }
`;

// Pinta la pantalla de login y resuelve cuando el usuario entra.
function ask(session, opts) {
  return new Promise(resolve => {
    if (!document.getElementById('ks-login-css')) {
      const st = document.createElement('style');
      st.id = 'ks-login-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    const el = document.createElement('div');
    el.className = 'ks-login';
    el.innerHTML = `
      <form class="ks-login-card" id="ks-login-form" autocomplete="on">
        <p class="ks-login-eyebrow">kisushotto</p>
        <h1>${opts.app}</h1>
        <input type="email" id="ks-login-email" placeholder="tu@email.com"
               autocomplete="username" required>
        <input type="password" id="ks-login-pass" placeholder="contraseña"
               autocomplete="current-password" required>
        <button type="submit" id="ks-login-btn">Entrar</button>
        <p class="ks-login-msg" id="ks-login-msg">${opts.message || ''}</p>
        <p class="ks-login-foot">La misma cuenta del resto del sitio.
          <a href="https://p2p.kisushotto.com/?forgot=1">¿Olvidaste la contraseña?</a></p>
      </form>`;
    document.body.appendChild(el);

    const form = el.querySelector('#ks-login-form');
    const mail = el.querySelector('#ks-login-email');
    const pass = el.querySelector('#ks-login-pass');
    const btn = el.querySelector('#ks-login-btn');
    const msg = el.querySelector('#ks-login-msg');

    mail.value = session.email();
    (mail.value ? pass : mail).focus();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Entrando…';
      msg.textContent = '';
      try {
        const email = mail.value.trim().toLowerCase();
        const token = await login(email, pass.value);
        session.save(token, email);
        el.remove();
        resolve(session);
      } catch (err) {
        msg.textContent = err.data && err.data.needVerify
          ? 'Verifica tu email antes de entrar.'
          : err.message;
        btn.disabled = false;
        btn.textContent = 'Entrar';
      }
    });
  });
}

// Devuelve una sesion con token, pidiendo login si hace falta.
// opts: { app: 'Notas', prefix: 'notes', message?: '...' }
export async function requireSession(opts) {
  const session = makeSession(opts.prefix);
  if (session.token()) return session;
  return ask(session, opts);
}

// Vuelve a pedir credenciales. Lo llama el wrapper de fetch cuando el worker
// responde 401: la sesion caduco a los 90 dias, o se revoco desde otro dispositivo.
export async function reauth(opts) {
  const session = makeSession(opts.prefix);
  session.clear();
  return ask(session, { ...opts, message: opts.message || 'Tu sesión expiró. Vuelve a entrar.' });
}

// fetch con el JWT puesto. Ante un 401 pide login y reintenta UNA vez, para que
// una sesion caducada no se lleve por delante la operacion que el usuario pidio.
export function makeAuthFetch(session, opts) {
  return async function authFetch(url, init = {}) {
    const send = () => fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: 'Bearer ' + session.token() },
    });
    let res = await send();
    if (res.status === 401) {
      await reauth(opts);
      res = await send();
    }
    return res;
  };
}

export function logout(prefix) {
  makeSession(prefix).clear();
  location.reload();
}
