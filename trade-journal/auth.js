// auth.js — login con el mismo JWT que el resto del sitio.
// El worker verifica la firma con el secreto compartido, sin llamar a Vercel.

const AUTH_BASE = 'https://kisushotto-site.vercel.app';

export const session = {
  token: () => localStorage.getItem('tj_jwt') || '',
  email: () => localStorage.getItem('tj_email') || '',
  save(token, email) {
    localStorage.setItem('tj_jwt', token);
    localStorage.setItem('tj_email', email);
  },
  clear() {
    localStorage.removeItem('tj_jwt');
    localStorage.removeItem('tj_email');
  },
};

async function post(path, body) {
  const res = await fetch(AUTH_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

let gateOpen = false;

export function showLogin(msg = '') {
  if (gateOpen) return;
  gateOpen = true;

  const el = document.createElement('div');
  el.id = 'tj-login';
  el.innerHTML = `
    <div class="tj-login-box">
      <div class="tj-login-label">// trade journal</div>
      <h1 class="tj-login-title">EDGE <span>ANALYTICS</span></h1>
      <div class="tj-login-sub">Inicia sesión para continuar</div>

      <form id="tj-login-form" autocomplete="on">
        <input type="email" id="tj-email" placeholder="email" autocomplete="username" required>
        <input type="password" id="tj-pass" placeholder="contraseña" autocomplete="current-password" required>
        <button type="submit" id="tj-login-btn">Entrar</button>
      </form>

      <div class="tj-login-msg" id="tj-login-msg">${msg}</div>
      <div class="tj-login-foot">
        <a href="${AUTH_BASE}/api/auth/forgot-password" id="tj-forgot">¿Olvidaste la contraseña?</a>
      </div>
    </div>`;
  document.body.appendChild(el);

  const form = el.querySelector('#tj-login-form');
  const btn  = el.querySelector('#tj-login-btn');
  const out  = el.querySelector('#tj-login-msg');
  const mail = el.querySelector('#tj-email');

  mail.value = session.email();
  (mail.value ? el.querySelector('#tj-pass') : mail).focus();

  form.onsubmit = async e => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    out.className = 'tj-login-msg';
    out.textContent = '';
    try {
      const email = mail.value.trim().toLowerCase();
      const { token } = await post('/api/auth/login', { email, password: el.querySelector('#tj-pass').value });
      session.save(token, email);
      location.reload();
    } catch (err) {
      out.className = 'tj-login-msg err';
      out.textContent = err.data?.needVerify
        ? 'Verifica tu email antes de entrar.'
        : err.message;
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  };
}

export function logout() {
  session.clear();
  location.reload();
}
