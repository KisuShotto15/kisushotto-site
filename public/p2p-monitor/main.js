// ── Moneda fiat + métodos de pago por moneda ──────────
var FIATS = ['VES', 'USD'];
var ACTIVE_FIAT = 'VES';
var PAY_METHODS_BY_FIAT = {
  VES: [
    { id: 'BancoDeVenezuela', label: 'BDV' },
    { id: 'Provincial',       label: 'Provincial' },
    { id: 'Mercantil',        label: 'Mercantil' },
    { id: 'Banesco',          label: 'Banesco' },
    { id: 'Bancamiga',        label: 'Bancamiga' },
    { id: 'BNCBancoNacional', label: 'BNC' },
    { id: 'PagoMovil',        label: 'Pago Móvil' }
  ],
  USD: [
    { id: 'Zinli',     label: 'Zinli' },
    { id: 'WallyTech', label: 'Wally Tech' },
    { id: 'Zelle',     label: 'Zelle' }
  ]
};
var PAY_METHODS = PAY_METHODS_BY_FIAT.VES; // lista activa (segun ACTIVE_FIAT)
var PAY_SEL = { VES: 'BancoDeVenezuela', USD: 'Zinli' }; // ultimo metodo elegido por moneda
var ACTIVE_PAY = 'BancoDeVenezuela';
// Sufijo de moneda para los displays del monitor (el bot es siempre VES/Bs)
function fiatSuf() { return ACTIVE_FIAT === 'VES' ? ' Bs' : ' $'; }
// Identifiers genéricos (catch-all) que NO deben usarse para filtrar competidores
// BANK = Bank Transfer (legítimo, lo usa el usuario junto a BDV) → no se filtra
var GENERIC_PAY_IDS = ['OtherPayments', 'SpecificBank'];
// Aliases: identifiers alternativos que Binance puede devolver para el mismo método
var PAY_ALIASES = {
  'BNC':                     'BNCBancoNacional',
  'BancoNacionalDeCredito':  'BNCBancoNacional',
  'BNCBank':                 'BNCBancoNacional',
  'BANK':                    'BANK'
};

function payLabel(id) {
  var canonical = PAY_ALIASES[id] || id;
  for (var f in PAY_METHODS_BY_FIAT) {
    var list = PAY_METHODS_BY_FIAT[f];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === canonical) return list[i].label;
    }
  }
  if (canonical === 'BANK') return 'Bank Transfer';
  return id;
}

function renderPaySelect() {
  var sel = document.getElementById('pay-method-select');
  if (sel) {
    sel.innerHTML = PAY_METHODS.map(function(m){
      return '<option value="' + m.id + '"' + (m.id === ACTIVE_PAY ? ' selected' : '') + '>' + m.label + '</option>';
    }).join('');
  }
}

function renderFiatSelect() {
  var fs = document.getElementById('fiat-select');
  if (fs) {
    fs.innerHTML = FIATS.map(function(f){
      return '<option value="' + f + '"' + (f === ACTIVE_FIAT ? ' selected' : '') + '>' + f + '</option>';
    }).join('');
  }
  var np = document.getElementById('nav-pair');
  if (np) np.textContent = ACTIVE_FIAT + '/USDT';
}

function loadPayMethod() {
  try {
    var ps = JSON.parse(localStorage.getItem('p2p_pay_by_fiat') || 'null');
    if (ps) {
      Object.assign(PAY_SEL, ps);
    } else {
      // Migracion desde la clave legada (solo VES)
      var saved = localStorage.getItem('p2p_pay_method');
      if (saved && PAY_METHODS_BY_FIAT.VES.some(function(m){ return m.id === saved; })) PAY_SEL.VES = saved;
    }
    var f = localStorage.getItem('p2p_fiat');
    if (f && PAY_METHODS_BY_FIAT[f]) ACTIVE_FIAT = f;
  } catch(e) {}
  PAY_METHODS = PAY_METHODS_BY_FIAT[ACTIVE_FIAT];
  var cur = PAY_SEL[ACTIVE_FIAT];
  ACTIVE_PAY = PAY_METHODS.some(function(m){ return m.id === cur; }) ? cur : PAY_METHODS[0].id;
  PAY_SEL[ACTIVE_FIAT] = ACTIVE_PAY;
  renderPaySelect();
  renderFiatSelect();
}

// Reset comun al cambiar de metodo o de moneda: los precios no son comparables
// entre series distintas (momentum de alertas, cooldowns y max/min de sesion).
function resetLocalSeries() {
  try {
    ST.priceHist = [];
    COOLDOWN = {};
  } catch(e) {}
}

function persistPaySel() {
  try {
    localStorage.setItem('p2p_pay_by_fiat', JSON.stringify(PAY_SEL));
    localStorage.setItem('p2p_fiat', ACTIVE_FIAT);
    if (ACTIVE_FIAT === 'VES') localStorage.setItem('p2p_pay_method', PAY_SEL.VES); // legado
  } catch(e) {}
}

function setPayMethod(id) {
  if (id === ACTIVE_PAY) return;
  // El bot corre server-side con los metodos de SU anuncio: cambiar el selector
  // del monitor no le afecta, se puede revisar otros metodos con el bot prendido.
  ACTIVE_PAY = id;
  PAY_SEL[ACTIVE_FIAT] = id;
  resetLocalSeries();
  persistPaySel();
  if (typeof fetchOnce === 'function') fetchOnce();
  saveUserSettings();
}

// Defaults de los 3 filtros de monto por moneda (USD: sin filtro, orden nativo de Binance)
var FIAT_FILTER_DEFAULTS = {
  VES: { may: 2000000, small: 59999, buy: 2000000 },
  USD: { may: 0, small: 0, buy: 0 }
};

function setFiat(id) {
  if (id === ACTIVE_FIAT || !PAY_METHODS_BY_FIAT[id]) return;
  // Guardar los filtros de la moneda saliente y cargar los de la entrante
  CFG.fiatFilters = CFG.fiatFilters || {};
  CFG.fiatFilters[ACTIVE_FIAT] = { may: CFG.mayAmount, small: CFG.smallAmount, buy: CFG.buyAmount };
  ACTIVE_FIAT = id;
  var f = CFG.fiatFilters[id] || FIAT_FILTER_DEFAULTS[id];
  CFG.mayAmount = f.may; CFG.smallAmount = f.small; CFG.buyAmount = f.buy;
  try { localStorage.setItem('p2p_cfg2', JSON.stringify(CFG)); } catch(e) {}
  PAY_METHODS = PAY_METHODS_BY_FIAT[id];
  var cur = PAY_SEL[id];
  ACTIVE_PAY = PAY_METHODS.some(function(m){ return m.id === cur; }) ? cur : PAY_METHODS[0].id;
  PAY_SEL[id] = ACTIVE_PAY;
  renderPaySelect();
  renderFiatSelect();
  resetLocalSeries();
  persistPaySel();
  syncFilterInputs();
  if (typeof renderSparkline === 'function') try { renderSparkline(); } catch(e) {}
  if (typeof fetchOnce === 'function') fetchOnce();
  saveUserSettings();
}

function updateBotPriceColor() {
  var el = document.getElementById('bot-cur-price');
  if (!el || !BOT.currentPrice || !BOT.ceiling) return;
  var ratio = BOT.currentPrice / BOT.ceiling;
  if (ratio > 1)         el.style.color = '#E24B4A';
  else if (ratio > 0.98) el.style.color = '#F0B90B';
  else if (ratio < 0.85) el.style.color = '#1D9E75';
  else                   el.style.color = 'var(--gold)';
}

function updateBotPayBadge() {
  var el = document.getElementById('bot-pay-badge');
  if (!el) return;
  if (BOT.adPayTypes && BOT.adPayTypes.length) {
    el.textContent = BOT.adPayTypes.map(payLabel).join(' · ');
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ── Config ────────────────────────────────────────────
var CFG = {
  interval: 30,
  spreadThr: 0.5,
  overboughtThr: 1.0,
  weaknessThr: 0.5,
  sustainThr: 1.5,       // Tendencia sostenida (~1h) en %
  mayAmount:   2000000,  // Monto a filtrar en sección Mayoristas (VES)
  smallAmount: 59999,    // Monto a filtrar en sección Ref. Compra (VES)
  commission:  0.0,      // Comisión Binance por anuncio (%)
  buyAmount:   2000000,  // Monto mínimo para Sección Compra (VES)
  verifiedOnly: true,    // Solo comerciantes con insignia (aplica a monitor y bot)
  monQuietStart: '00:00',// Monitor 24/7: inicio del silencio nocturno (America/Caracas)
  monQuietEnd:   '07:00',// Monitor 24/7: fin del silencio nocturno
  monQuietRef:   3600,   // Monitor 24/7: refresco nocturno (seg); alto para que Neon se suspenda de noche
  monSummary:    '08:00' // Monitor 24/7: hora del resumen diario por Telegram (Caracas)
};

var PROXY = 'https://kisushotto-site.vercel.app/api/p2p-search';
var API_BASE = 'https://kisushotto-site.vercel.app';

// ── Sesion (multi-usuario) ────────────────────────────
var SESSION = { token: null, email: null };
try {
  var _s = JSON.parse(localStorage.getItem('p2p_session') || 'null');
  if (_s && _s.token) SESSION = _s;
} catch(e) {}

function saveSession() { try { localStorage.setItem('p2p_session', JSON.stringify(SESSION)); } catch(e) {} }

// ── Sync de preferencias por cuenta (last-write-wins) ──
var _saveSettingsT = null;
function saveUserSettings() {
  if (!SESSION.token) return;
  clearTimeout(_saveSettingsT);
  _saveSettingsT = setTimeout(function() {
    var data = { cfg: CFG, bot: BOT_CFG, pay: PAY_SEL.VES, paySel: PAY_SEL, fiat: ACTIVE_FIAT };
    botCallWorker('/settings-save', { data: data }).catch(function(){});
  }, 800);
}

async function loadUserSettings() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/settings-get');
    var s = d && d.data;
    if (!s) return;
    if (s.cfg) localStorage.setItem('p2p_cfg2', JSON.stringify(s.cfg));
    if (s.bot) localStorage.setItem('p2p_bot_cfg', JSON.stringify(s.bot));
    if (s.pay) localStorage.setItem('p2p_pay_method', s.pay);
    if (s.paySel) localStorage.setItem('p2p_pay_by_fiat', JSON.stringify(s.paySel));
    if (s.fiat) localStorage.setItem('p2p_fiat', s.fiat);
    // Reusar los loaders existentes para repintar inputs desde localStorage
    loadConfig(); syncFilterInputs(); loadBotConfig(); loadPayMethod();
    updateCommissionLabels(); updateVerToggle(); botUpdateCeiling();
    if (ST.running) fetchOnce();
  } catch(e) {}
}

async function apiPost(path, body, auth) {
  var headers = { 'Content-Type': 'application/json' };
  if (auth && SESSION.token) headers['Authorization'] = 'Bearer ' + SESSION.token;
  // 20s: binance-connect valida contra Binance + cold start de Vercel; con 8s el
  // cliente abortaba con "Timeout" antes de que el servidor terminara.
  var r = await fetchRetry(API_BASE + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) }, 20000);
  var d = await r.json().catch(function(){ return {}; });
  if (!r.ok) { var err = new Error(d.error || ('HTTP ' + r.status)); err.data = d; throw err; }
  return d;
}

function gateStatus(msg, color) {
  var st = document.getElementById('gate-st');
  if (st) { st.textContent = msg; st.style.color = color; }
}

async function authRegister() {
  var email = document.getElementById('gate-email').value.trim();
  var pass  = document.getElementById('gate-pass').value;
  if (!email || pass.length < 8) { gateStatus('⚠ Email y contraseña (min 8)', 'var(--red)'); return; }
  gateStatus('Creando cuenta...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/register', { email: email, password: pass });
    if (d.emailError) gateStatus('Cuenta creada, pero no se pudo enviar el email: ' + d.emailError, 'var(--red)');
    else gateStatus('✓ Revisa tu email para verificar la cuenta', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

async function authLogin() {
  var email = document.getElementById('gate-email').value.trim();
  var pass  = document.getElementById('gate-pass').value;
  gateStatus('Entrando...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/login', { email: email, password: pass });
    SESSION = { token: d.token, email: email }; saveSession();
    gateStatus('✓ Sesión iniciada', '#1D9E75');
    enterApp(); refreshAuthUI();
  } catch(e) {
    if (e.data && e.data.needVerify) {
      gateStatus('Verifica tu email. ', 'var(--red)');
      var st = document.getElementById('gate-st');
      var a = document.createElement('a');
      a.href = '#'; a.textContent = 'Reenviar verificación';
      a.style.cssText = 'color:var(--gold);text-decoration:none';
      a.onclick = function(){ authResend(); return false; };
      st.appendChild(a);
    } else gateStatus('⚠ ' + e.message, 'var(--red)');
  }
}

async function authForgot() {
  var email = document.getElementById('gate-email').value.trim();
  if (!email) { gateStatus('Escribe tu email arriba primero', 'var(--text-3)'); return; }
  gateStatus('Enviando enlace...', 'var(--text-3)');
  try {
    await apiPost('/api/auth/forgot-password', { email: email });
    gateStatus('Si el email existe, te enviamos un enlace para restablecer', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

async function authResend() {
  var email = document.getElementById('gate-email').value.trim();
  if (!email) { gateStatus('Escribe tu email arriba primero', 'var(--text-3)'); return; }
  gateStatus('Reenviando...', 'var(--text-3)');
  try {
    await apiPost('/api/auth/resend-verification', { email: email });
    gateStatus('Si la cuenta existe y no está verificada, te reenviamos el email', '#1D9E75');
  } catch(e) { gateStatus('⚠ ' + e.message, 'var(--red)'); }
}

function resetStatus(msg, color) {
  var st = document.getElementById('reset-st');
  if (st) { st.textContent = msg; st.style.color = color; }
}

async function authResetPassword() {
  var pass = document.getElementById('reset-pass').value;
  if (pass.length < 8) { resetStatus('Mínimo 8 caracteres', 'var(--red)'); return; }
  resetStatus('Cambiando...', 'var(--text-3)');
  try {
    var d = await apiPost('/api/auth/reset-password', { token: window._resetToken, password: pass });
    if (d.token) { SESSION = { token: d.token, email: d.email }; saveSession(); resetStatus('✓ Listo', '#1D9E75'); cleanAuthUrl(); enterApp(); refreshAuthUI(); }
    else { resetStatus('✓ Contraseña cambiada, inicia sesión', '#1D9E75'); showLoginForm(); }
  } catch(e) { resetStatus('⚠ ' + e.message, 'var(--red)'); }
}

function showLoginForm() {
  document.getElementById('gate-form').style.display = '';
  document.getElementById('gate-reset').style.display = 'none';
}

function cleanAuthUrl() {
  try { history.replaceState(null, '', location.pathname); } catch(e) {}
}

// Procesa ?verify=TOKEN y ?reset=TOKEN del enlace de email. Devuelve true si manejo algo.
async function handleAuthLinks() {
  var q = new URLSearchParams(location.search);
  var verify = q.get('verify'), reset = q.get('reset');
  if (verify) {
    document.getElementById('login-gate').style.display = 'flex';
    gateStatus('Verificando...', 'var(--text-3)');
    try {
      var d = await apiPost('/api/auth/verify-email', { token: verify });
      cleanAuthUrl();
      if (d.token) { SESSION = { token: d.token, email: d.email }; saveSession(); gateStatus('✓ Email verificado', '#1D9E75'); enterApp(); refreshAuthUI(); }
      else gateStatus('✓ Email verificado, inicia sesión', '#1D9E75');
    } catch(e) { cleanAuthUrl(); gateStatus('⚠ ' + e.message, 'var(--red)'); }
    return true;
  }
  if (reset) {
    window._resetToken = reset;
    document.getElementById('login-gate').style.display = 'flex';
    showLoginForm();
    document.getElementById('gate-form').style.display = 'none';
    document.getElementById('gate-reset').style.display = '';
    return true;
  }
  return false;
}

function authLogout() {
  SESSION = { token: null, email: null }; saveSession();
  try { if (ST.running) toggleMonitor(); } catch(e) {}
  var g = document.getElementById('login-gate');
  if (g) g.style.display = 'flex';
  refreshAuthUI();
}

function enterApp() {
  var g = document.getElementById('login-gate');
  if (g) g.style.display = 'none';
  if (!window._appBooted) { window._appBooted = true; try { loadUserSettings(); } catch(e) {} try { hydrateBotState(); } catch(e) {} try { hydrateMon24(); } catch(e) {} try { loadOrderStats(); } catch(e) {} }
}

// Al cargar: si hay sesion valida (email autorizado), entra; si no, queda el muro.
async function initAuth() {
  if (!SESSION.token) return;        // sin token: queda el muro
  enterApp(); refreshAuthUI();       // optimista: entra ya, sin esperar a la red
  try {
    var r = await fetchRetry(API_BASE + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + SESSION.token } });
    if (r.status === 401 || r.status === 403) { authLogout(); return; } // token invalido/expirado
    if (!r.ok) return;               // error transitorio del server: mantener sesion
    var d = await r.json().catch(function(){ return {}; });
    if (d.email) { SESSION.email = d.email; saveSession(); refreshAuthUI(); }
  } catch(e) { /* sin red: mantener sesion, no cerrar */ }
}

async function binanceConnect() {
  var st = document.getElementById('bnc-st');
  var apiKey = document.getElementById('cfg-bnc-key').value.trim();
  var apiSecret = document.getElementById('cfg-bnc-secret').value.trim();
  st.textContent = 'Validando con Binance...'; st.style.color = 'var(--text-3)';
  try {
    var d = await apiPost('/api/binance-connect', { apiKey: apiKey, apiSecret: apiSecret }, true);
    st.textContent = '✓ Conectado'; st.style.color = '#1D9E75';
    document.getElementById('cfg-bnc-key').value = '';
    document.getElementById('cfg-bnc-secret').value = '';
    bncSetConnected(true);
    loadMyAds();
  } catch(e) { st.textContent = '⚠ ' + e.message; st.style.color = 'var(--red)'; }
}

function bncSetConnected(connected) {
  var c = document.getElementById('bnc-connected');
  var f = document.getElementById('bnc-form');
  if (!c || !f) return;
  c.style.display = connected ? 'flex' : 'none';
  f.style.display = connected ? 'none' : '';
}

function bncShowForm() {
  var c = document.getElementById('bnc-connected');
  var f = document.getElementById('bnc-form');
  if (c) c.style.display = 'none';
  if (f) f.style.display = '';
}

async function botSuggestSell() {
  if (ACTIVE_FIAT !== 'VES') { toast('Cambia la vista a VES para sugerir (el bot opera en VES)'); return; }
  var ref = ST.buyAds && ST.buyAds[0] ? ST.buyAds[0].price : null;
  if (!ref) {
    // Seccion Compra colapsada o monitor parado: pedir la pagina BUY al momento.
    try {
      var raw = await searchBatch([buildSearchBody({ transAmount: CFG.buyAmount, page: 1, pays: [PAY_SEL.VES], tradeType: 'BUY' })]);
      var ads = mapBuyAds(raw[0] || []);
      if (ads[0]) ref = ads[0].price;
    } catch(e) {}
  }
  if (!ref) { toast('Sin datos de mercado aún'); return; }
  var inp = document.getElementById('cfg-bot-sell');
  inp.value = Math.round(ref);
  botUpdateCeiling();
}

// Metricas de rotacion: volumen/ordenes desde la tabla orders del servidor.
// La ganancia es spread x capital x rotaciones: esto mide la rotacion real.
async function loadOrderStats() {
  var el = document.getElementById('order-stats');
  if (!el || !SESSION.token) return;
  el.textContent = 'Cargando...';
  try {
    var d = await botCallWorker('/order-stats');
    if (d.error) throw new Error(d.error);
    var gap = d.medGapSec ? (d.medGapSec < 3600 ? Math.round(d.medGapSec / 60) + ' min' : (d.medGapSec / 3600).toFixed(1) + ' h') : '—';
    var top = (d.hours || []).slice().sort(function(a, b){ return b.usdt - a.usdt; }).slice(0, 3)
      .map(function(h){ return String(h.h).padStart(2, '0') + 'h (' + Math.round(h.usdt) + ')'; }).join(' · ');
    el.innerHTML =
      'Hoy: <b>' + d.today.done + '</b> órdenes · <b>' + Math.round(d.today.usdt) + '</b> USDT · ' + fmt(Math.round(d.today.ves)) + ' Bs<br>' +
      '7 días: <b>' + d.week.done + '</b> órdenes · <b>' + Math.round(d.week.usdt) + '</b> USDT (' + Math.round(d.week.usdt / 7) + '/día)<br>' +
      'Tiempo mediano entre órdenes: <b>' + gap + '</b><br>' +
      (top ? 'Mejores horas (USDT, 30d): ' + top : 'Mejores horas: aún sin datos');
  } catch (e) {
    el.textContent = 'Sin datos aún (se acumulan con el bot encendido)';
  }
}

async function refreshAuthUI() {
  var inEl = document.getElementById('auth-in');
  if (!inEl) return;
  var logged = !!SESSION.token;
  inEl.style.display = logged ? '' : 'none';
  if (logged) {
    document.getElementById('auth-email').textContent = SESSION.email || '';
    try {
      var r = await fetchRetry(API_BASE + '/api/binance-status', {
        method: 'GET', headers: { 'Authorization': 'Bearer ' + SESSION.token }
      });
      if (r.status === 401) { authLogout(); return; }
      var d = await r.json().catch(function(){ return {}; });
      var bnc = document.getElementById('bnc-st');
      if (d.connected) { bnc.textContent = '✓ Conectado'; bnc.style.color = '#1D9E75'; bncSetConnected(true); loadMyAds(); }
    } catch(e) {}
  }
}

// ── Estado ───────────────────────────────────────────
var ST = {
  running: false,
  timer: null,
  allAds: [],
  mayoristas: [],
  smallAds: [],
  buyAds: [],
  priceHist: [],   // {ts, price}
  alerts: [],
  lastFetch: null,
  consecFails: 0
};

var COOLDOWN = {};
var COOLDOWN_MS = 5 * 60000;

// ── API ──────────────────────────────────────────────
// Construye el body de busqueda P2P
function buildSearchBody(opts) {
  var body = {
    asset: 'USDT',
    fiat: ACTIVE_FIAT,
    merchantCheck: false,
    page: opts.page,
    rows: 20,
    tradeType: opts.tradeType || 'SELL',
    payTypes: opts.pays
  };
  // Pre-filtrar verificados en Binance (como el toggle "Solo comerciantes" de su web):
  // paginas llenas de verificados → sin huecos y sin pedir paginas extra.
  if (CFG.verifiedOnly) body.publisherType = 'merchant';
  if (opts.fiat) body.fiat = opts.fiat; // override (el bot siempre busca en VES)
  if (opts.transAmount && parseFloat(opts.transAmount) > 0) body.transAmount = opts.transAmount;
  return body;
}

// Lote: 1 sola llamada Vercel para N paginas. Devuelve array alineado por indice (data[] por query).
// ── Red con timeout + reintento ───────────────────────
async function fetchWithTimeout(url, opts, ms) {
  ms = ms || 8000;
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fetchRetry(url, opts, ms, retries) {
  retries = (retries == null) ? 1 : retries;
  var lastErr;
  for (var i = 0; i <= retries; i++) {
    try {
      var r = await fetchWithTimeout(url, opts, ms);
      if (r.status >= 500 || r.status === 429) {
        if (i < retries) { await new Promise(function(res){ setTimeout(res, 600); }); continue; }
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < retries) { await new Promise(function(res){ setTimeout(res, 600); }); continue; }
      throw e;
    }
  }
  throw lastErr;
}

async function searchBatch(bodies) {
  var r = await fetchRetry(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (SESSION.token || '') },
    body: JSON.stringify({ queries: bodies })
  });
  if (r.status === 401 || r.status === 403) { authLogout(); throw new Error('Sesión expirada'); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var d = await r.json();
  if (d.error) throw new Error(d.error);
  return (d.results || []).map(function(res) { return (res && res.data) || []; });
}

// Solo lo usa el bot (reprice inicial): SIEMPRE mercado VES, sin importar la vista.
async function fetchTier(transAmount, maxPages, payTypesOverride) {
  maxPages = maxPages || 2;
  var pays = (payTypesOverride && payTypesOverride.length) ? payTypesOverride : [PAY_SEL.VES];
  var bodies = [];
  for (var i = 1; i <= maxPages; i++) {
    bodies.push(buildSearchBody({ transAmount: transAmount, page: i, pays: pays, tradeType: 'SELL', fiat: 'VES' }));
  }
  var results = await searchBatch(bodies);
  return results.flatMap(function(arr) { return arr; });
}

// keepOrder=true (filtro de monto en 0): conserva el orden nativo de Binance.
// Con filtro de monto: ordena desc por precio (mejor mayorista primero).
function mapAds(raw, keepOrder) {
  var mapped = raw.map(function(item) {
    return {
      advNo:    item.adv.advNo,
      price:    parseFloat(item.adv.price),
      minVES:   parseFloat(item.adv.minSingleTransAmount),
      maxVES:   parseFloat(item.adv.maxSingleTransAmount),
      avail:    parseFloat(item.adv.tradableQuantity),
      merchant: item.advertiser.nickName,
      orders:   item.advertiser.monthOrderCount,
      comp:     Math.round((item.advertiser.monthFinishRate || 0) * 100),
      payTypes:  (item.adv.tradeMethods || []).map(function(m) { return m.identifier; }),
      badges:    item.advertiser.badges,
      vipLevel:  item.advertiser.vipLevel
    };
  }).filter(function(a) {
    // Solo comerciantes con insignia (Bronze/Silver/Gold/Block/Ordinary/PRO)
    // badges: null = sin insignia → excluir (si el filtro esta activo)
    return !CFG.verifiedOnly || (a.badges && a.badges.length > 0);
  });
  if (!keepOrder) mapped.sort(function(a, b) { return b.price - a.price; });
  return mapped;
}

// ── Sección Compra (BUY) ─────────────────────────────
function mapBuyAds(raw) {
  return raw.map(function(item) {
    return {
      advNo:   item.adv.advNo,
      price:   parseFloat(item.adv.price),
      minVES:  parseFloat(item.adv.minSingleTransAmount),
      maxVES:  parseFloat(item.adv.maxSingleTransAmount),
      avail:   parseFloat(item.adv.tradableQuantity),
      merchant: item.advertiser.nickName,
      orders:  item.advertiser.monthOrderCount,
      comp:    Math.round((item.advertiser.monthFinishRate || 0) * 100),
      badges:  item.advertiser.badges,
      vipLevel: item.advertiser.vipLevel
    };
  }).filter(function(a) {
    return (!CFG.verifiedOnly || (a.badges && a.badges.length > 0)) && a.maxVES >= CFG.buyAmount;
  }).sort(function(a, b) { return a.price - b.price; });  // ascendente: más barato primero
}

// ── Acumulador de variacion de avail ──────────────────
// Ventana deslizante: cada variacion vive ACCUM_WINDOW_MS y luego se descuenta
// del total. El valor mostrado = suma de variaciones de los ultimos 60s.
var ACCUM_WINDOW_MS = 60000;
function accumAvail(section, ads, prevMap) {
  ST.availAccum = ST.availAccum || {};
  var acc = ST.availAccum[section] = ST.availAccum[section] || {};
  var now = Date.now();
  var present = {};
  var display = {};
  ads.forEach(function(ad) {
    present[ad.advNo] = true;
    var ev = acc[ad.advNo] || [];
    var prev = prevMap[ad.advNo];
    if (prev !== undefined) {
      var delta = ad.avail - prev;
      if (delta !== 0) ev.push({ ts: now, delta: delta });
    }
    ev = ev.filter(function(e){ return now - e.ts < ACCUM_WINDOW_MS; });
    acc[ad.advNo] = ev;
    var sum = ev.reduce(function(s, e){ return s + e.delta; }, 0);
    if (sum !== 0) display[ad.advNo] = { value: sum };
  });
  // limpiar merchants que ya no estan en el top
  Object.keys(acc).forEach(function(m){ if (!present[m]) delete acc[m]; });
  return display;
}

// Filas visibles en cada libro: 10 por defecto, 15 al expandir con "ver mas".
var OB_BASE_ROWS = 10, OB_MAX_ROWS = 15;
// Indicador +X en el titulo: anuncios fetcheados que no caben en los visibles.
function setExtraCount(id, fetched) {
  var el = document.getElementById(id);
  if (!el) return;
  // +X = comercios traidos de Binance mas alla del maximo que muestra la UI (15).
  var extra = fetched - OB_MAX_ROWS;
  el.textContent = extra > 0 ? '+' + extra : '';
  el.title = extra > 0 ? fetched + ' anuncios traidos de Binance, ' + OB_MAX_ROWS + ' visibles como maximo' : '';
}

function availArrowHtml(d) {
  if (!d || !d.value) return '';
  var v = d.value, av = Math.abs(v);
  var s = av >= 1000
    ? (av / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
    : Math.round(av).toLocaleString('es-VE');
  if (v > 0) return '<span class="avail-arrow up" title="Recargó +' + Math.round(v) + ' USDT (últ. 60s)">+' + s + '</span>';
  return '<span class="avail-arrow down" title="Vendió ' + Math.round(v) + ' USDT (últ. 60s)">-' + s + '</span>';
}

function availPopupHtml(d) {
  if (!d || !d.value) return '';
  var v = d.value, av = Math.abs(v);
  var s = av >= 1000
    ? (av / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
    : Math.round(av).toLocaleString('es-VE');
  if (v > 0) return '<span class="avail-popup up">+' + s + '</span>';
  return '<span class="avail-popup down">-' + s + '</span>';
}

// ── Ciclo principal ───────────────────────────────────
// Un solo batch combinado: paginas may + small + buy en 1 request Vercel
var MAY_PAGES = 1, SMALL_PAGES = 1;
async function fetchOnce() {
  document.getElementById('last-update').textContent = 'Cargando...';
  try {
    // Si la Sección Compra está colapsada, no pedir su página (1 llamada Binance menos por ciclo).
    var buyBody = document.getElementById('buy-section-body');
    var includeBuy = !buyBody || buyBody.style.display !== 'none';

    var bodies = [];
    for (var i = 1; i <= MAY_PAGES; i++)   bodies.push(buildSearchBody({ transAmount: CFG.mayAmount,   page: i, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
    for (var j = 1; j <= SMALL_PAGES; j++) bodies.push(buildSearchBody({ transAmount: CFG.smallAmount, page: j, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
    if (includeBuy) bodies.push(buildSearchBody({ transAmount: CFG.buyAmount, page: 1, pays: [ACTIVE_PAY], tradeType: 'BUY' }));

    var batch = await searchBatch(bodies);
    var mayRaw   = batch.slice(0, MAY_PAGES).flatMap(function(a){ return a; });
    var smallRaw = batch.slice(MAY_PAGES, MAY_PAGES + SMALL_PAGES).flatMap(function(a){ return a; });
    var buyRaw   = includeBuy ? (batch[MAY_PAGES + SMALL_PAGES] || []) : null;

    var prevMayAvail = {};
    (ST.mayoristas || []).forEach(function(a){ prevMayAvail[a.advNo] = a.avail; });

    var prevSmallAvail = {};
    (ST.smallAds || []).forEach(function(a){ prevSmallAvail[a.advNo] = a.avail; });

    var prevBuyAvail = {};
    (ST.buyAds || []).forEach(function(a){ prevBuyAvail[a.advNo] = a.avail; });

    ST.mayoristas = mapAds(mayRaw,   !(CFG.mayAmount   > 0));
    ST.smallAds   = mapAds(smallRaw, !(CFG.smallAmount > 0));

    // Top-up: si el filtro de verificados deja <8 filas y Binance tiene mas paginas
    // (las pedidas vinieron llenas), pedir hasta 3 paginas extra solo para esa tabla.
    // Con filtros VES bajos las primeras paginas vienen dominadas por no-verificados.
    var EXTRA_PAGES = 3;
    var extraBodies = [], extraMeta = [];
    if (ST.mayoristas.length < 8 && mayRaw.length >= MAY_PAGES * 20) {
      for (var ep = MAY_PAGES + 1; ep <= MAY_PAGES + EXTRA_PAGES; ep++) {
        extraBodies.push(buildSearchBody({ transAmount: CFG.mayAmount, page: ep, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
        extraMeta.push('may');
      }
    }
    if (ST.smallAds.length < 8 && smallRaw.length >= SMALL_PAGES * 20) {
      for (var es = SMALL_PAGES + 1; es <= SMALL_PAGES + EXTRA_PAGES; es++) {
        extraBodies.push(buildSearchBody({ transAmount: CFG.smallAmount, page: es, pays: [ACTIVE_PAY], tradeType: 'SELL' }));
        extraMeta.push('small');
      }
    }
    if (extraBodies.length) {
      var extra = await searchBatch(extraBodies);
      var mayExtra = [], smallExtra = [];
      extra.forEach(function(arr, xi) {
        if (extraMeta[xi] === 'may') mayExtra = mayExtra.concat(arr || []);
        else smallExtra = smallExtra.concat(arr || []);
      });
      if (mayExtra.length)   ST.mayoristas = mapAds(mayRaw.concat(mayExtra),     !(CFG.mayAmount   > 0));
      if (smallExtra.length) ST.smallAds   = mapAds(smallRaw.concat(smallExtra), !(CFG.smallAmount > 0));
    }

    if (buyRaw !== null) ST.buyAds = mapBuyAds(buyRaw); // colapsada: conservar última data

    // +X en los titulos: candidatos reales (ya filtrados) que no caben en los 8 visibles
    setExtraCount('extra-may', ST.mayoristas.length);
    setExtraCount('extra-small', ST.smallAds.length);
    if (buyRaw !== null) setExtraCount('extra-buy', ST.buyAds.length);

    ST.availDisp = ST.availDisp || {};
    ST.availDisp['ob-may']   = accumAvail('ob-may',   ST.mayoristas, prevMayAvail);
    ST.availDisp['ob-small'] = accumAvail('ob-small', ST.smallAds,   prevSmallAvail);
    if (buyRaw !== null) ST.availDisp['ob-buy'] = accumAvail('ob-buy', ST.buyAds, prevBuyAvail);

    ST.allAds     = ST.mayoristas; // para compatibilidad con historial

    // Historial de precio (mejor mayorista creible, sin listings fantasma)
    var bestMay = bestCredibleMay();
    if (bestMay) {
      ST.priceHist.push({ ts: Date.now(), price: bestMay });
      if (ST.priceHist.length > 600) ST.priceHist.shift();
    }

    ST.lastFetch = new Date();
    ST.consecFails = 0;
    // Latir SOLO tras fetch exitoso: si la app esta abierta pero fallando,
    // el servidor debe tomar el relevo (no decirle "yo cubro" sin datos).
    monitorHeartbeat();
    renderAll();
    checkAlerts();
    renderSparkline();
    refreshHist24();
    var emptyNote =(!ST.mayoristas.length && !ST.smallAds.length) ? ' — sin anuncios en rango' : '';
    var lu = document.getElementById('last-update');
    lu.style.color = '';
    lu.textContent = 'Actualizado ' + ST.lastFetch.toLocaleTimeString('es-VE') + emptyNote;
  } catch(e) {
    ST.consecFails++;
    var lu2 = document.getElementById('last-update');
    if (ST.consecFails >= 2) {
      var okStr = ST.lastFetch ? ' (último OK ' + ST.lastFetch.toLocaleTimeString('es-VE') + ')' : '';
      lu2.style.color = 'var(--red)';
      lu2.textContent = '⚠ Sin conexión — datos viejos' + okStr;
    } else {
      lu2.textContent = '⚠ ' + e.message;
    }
    // Solo alertar al transicionar a "sin conexion" (no en cada fallo → spam)
    if (ST.consecFails === 2) addAlert('info', 'Error de conexión', e.message);
  }
}

function startMonitorView() {
  if (ST.running) return;
  ST.running = true;
  fetchOnce();
  ST.timer = setInterval(fetchOnce, CFG.interval * 1000);
  document.getElementById('btn-start').textContent = '⏹ Detener';
  setBadge(true);
}

function stopMonitorView() {
  ST.running = false;
  clearInterval(ST.timer); ST.timer = null;
  document.getElementById('btn-start').textContent = '▶ Iniciar';
  setBadge(false);
}

// Un solo boton: arranca/detiene la vista (tablas) Y el monitor 24/7 server-side.
function toggleMonitor() {
  if (ST.running) {
    stopMonitorView();
    monitorServerDisable();
  } else {
    saveConfig();
    startMonitorView();
    monitorServerEnable();
  }
}

// Pestana oculta: pausa el fetch visual (sin apagar el monitor). Deja de latir → a los ~70s
// el servidor toma el relevo (notificaciones siguen). Al volver, reanuda y el servidor cede.
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    // Pestaña oculta: sin UI que actualizar. Pausar los pollers que pegan a la red
    // (fetch de precios y poller del bot) para no gastar invocaciones Vercel en vano.
    // El servidor cubre monitor y bot 24/7. ACTIVITY es local + seguridad: no se toca.
    if (ST.running && ST.timer) { clearInterval(ST.timer); ST.timer = null; }
    if (BOT.running) stopBotPoller();
    return;
  }
  // Volver a visible: pollear de inmediato y re-armar.
  if (ST.running && !ST.timer) {
    fetchOnce();
    ST.timer = setInterval(fetchOnce, CFG.interval * 1000);
  }
  if (BOT.running && !BOT_POLL.timer) startBotPoller();
});

function setBadge(live) {
  document.getElementById('live-badge').className = 'badge ' + (live ? 'badge-live' : 'badge-off');
  document.getElementById('live-dot').className   = 'dot ' + (live ? 'dot-live' : 'dot-off');
  document.getElementById('live-label').textContent = live ? 'En vivo' : 'Detenido';
}

// ── Render ────────────────────────────────────────────
function fmtAmount(n) {
  if (n >= 1000000) return (n / 1000000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'M';
  if (n >= 1000)    return (n / 1000).toLocaleString('es-VE', {maximumFractionDigits: 0}) + 'k';
  return n.toString();
}

function renderAll() {
  renderSpreadHero();
  renderStats();
  renderOB('ob-may',   ST.mayoristas, 'best');
  renderOB('ob-small', ST.smallAds,   'best-buy');
  renderBuySection(ST.buyAds);
  renderBuySpread();
  updateSessionStats();
}

function updateSessionStats() {
  // Max/min de las ULTIMAS 24H: misma fuente y ventana que el resumen diario de
  // Telegram (serie del servidor + puntos vivos), sobrevive recargas de pagina.
  var pts = sparkSeries();
  var now = Date.now(), min = null, max = null;
  for (var i = 0; i < pts.length; i++) {
    if (now - pts[i].ts > 24 * 3600e3) continue;
    if (min === null || pts[i].price < min) min = pts[i].price;
    if (max === null || pts[i].price > max) max = pts[i].price;
  }
  // Incluir el precio creible actual aunque aun no haya entrado a la serie
  var cur = bestCredibleMay();
  if (cur) {
    if (min === null || cur < min) min = cur;
    if (max === null || cur > max) max = cur;
  }
  document.getElementById('sess-max').textContent = max !== null ? fmt(max) + fiatSuf() : '—';
  document.getElementById('sess-min').textContent = min !== null ? fmt(min) + fiatSuf() : '—';
}

function updateTopbarBotPrice(price) {
  var el = document.getElementById('topbar-bot-price');
  if (price && BOT.running) {
    el.textContent = fmt(price) + ' Bs';
    el.style.display = 'inline-flex';
  } else {
    el.style.display = 'none';
  }
}

function renderSpreadHero() {
  // Mismo filtro de credibilidad (>=2000 USDT) que gráfico/alertas.
  var cMayH = credibleMay(), cSmallH = credibleSmall();
  var bestMay   = cMayH   ? cMayH.price   : null;
  var bestSmall = cSmallH ? cSmallH.price : null;

  if (!bestMay) {
    document.getElementById('hero-pct').textContent   = '—';
    document.getElementById('hero-pct').style.color   = 'var(--text-3)';
    document.getElementById('hero-label').textContent = 'Esperando datos...';
    document.getElementById('hero-may').textContent   = '—';
    document.getElementById('hero-small').textContent = '—';
    var pill = document.getElementById('hero-pill');
    pill.className = 'sh-pill opp-no'; pill.textContent = 'Sin datos';
    return;
  }

  document.getElementById('hero-may').textContent   = fmt(bestMay)   + fiatSuf();
  document.getElementById('hero-small').textContent = bestSmall ? fmt(bestSmall) + fiatSuf() : '—';

  if (!bestSmall) {
    document.getElementById('hero-pct').textContent   = '—';
    document.getElementById('hero-pct').style.color   = 'var(--text-3)';
    document.getElementById('hero-label').textContent = 'Sin referencia de compra';
    var pill2 = document.getElementById('hero-pill');
    pill2.className = 'sh-pill opp-no'; pill2.textContent = 'Sin datos';
    return;
  }

  var spread    = (bestMay - bestSmall) / bestMay * 100;
  var spreadNet = spread - (CFG.commission || 0);
  var spreadBs  = bestMay - bestSmall;

  var pct  = document.getElementById('hero-pct');
  var pill = document.getElementById('hero-pill');
  var threshold = CFG.spreadThr;
  var commNote  = CFG.commission > 0 ? '  ·  −' + CFG.commission + '% comisión' : '';

  pct.textContent = spreadNet.toFixed(3) + '%';

  if (spreadNet <= 0) {
    pct.style.color = 'var(--red)';
    document.getElementById('hero-label').textContent = (spread <= 0 ? 'Mercado invertido' : 'Comisión supera el spread') + '  ·  Dif: ' + fmt(spreadBs) + fiatSuf() + '/USDT';
    pill.className = 'sh-pill opp-warn';
    pill.textContent = '⚠ Neto negativo';
  } else if (spreadNet >= threshold) {
    pct.style.color = 'var(--gold)';
    document.getElementById('hero-label').textContent = 'Diferencia: ' + fmt(spreadBs) + fiatSuf() + '/USDT' + commNote;
    pill.className = 'sh-pill opp-yes';
    pill.textContent = '🟡 NETO > ' + threshold + '% — OPORTUNIDAD';
  } else {
    pct.style.color = 'var(--text-2)';
    document.getElementById('hero-label').textContent = 'Diferencia: ' + fmt(spreadBs) + fiatSuf() + '/USDT' + commNote;
    pill.className = 'sh-pill opp-no';
    pill.textContent = 'Neto por debajo del umbral';
  }
}

function renderStats() {
  var cMayS = credibleMay(), cSmallS = credibleSmall();
  var bestMay   = cMayS   ? cMayS.price   : null;
  var bestSmall = cSmallS ? cSmallS.price : null;

  document.getElementById('st-best').textContent  = bestMay   ? fmt(bestMay)   + fiatSuf() : '—';
  document.getElementById('st-count').textContent = ST.mayoristas.length;

  if (bestMay && bestSmall) {
    var diff = bestMay - bestSmall;
    document.getElementById('st-diff').textContent = fmt(diff) + fiatSuf();
  } else {
    document.getElementById('st-diff').textContent = '—';
  }

  var el = document.getElementById('st-delta');
  if (bestMay && ST.priceHist.length > 1) {
    var now = Date.now();
    var ref = null;
    for (var i = ST.priceHist.length - 1; i >= 0; i--) {
      var ageD = now - ST.priceHist[i].ts;
      if (ageD >= 9 * 60000) { if (ageD <= 18 * 60000) ref = ST.priceHist[i].price; break; }
    }
    if (ref !== null) {
      var d = (bestMay - ref) / ref * 100;
      el.textContent = (d >= 0 ? '+' : '') + d.toFixed(3) + '%';
      el.className = 'sc-v ' + (d > 0 ? 'g' : d < 0 ? 'r' : '');
    } else { el.textContent = '—'; }
  } else { el.textContent = '—'; }
}

var MY_NICK = 'キスショット';

// Si la fila idx es mia, indica si me estan "pisando": alguien mejor posicionado
// (arriba) con limite minimo <= al mio y disponibilidad real (>=150). rojo = pisado, verde = libre.
function pisadoCls(ads, idx) {
  var me = ads[idx];
  if (!me || me.merchant !== MY_NICK) return '';
  for (var j = 0; j < idx; j++) {
    var c = ads[j];
    if (c && c.avail >= 150 && c.minVES <= me.minVES) return ' pisado';
  }
  return ' libre';
}

function renderOB(id, ads, bestCls) {
  var wrap = document.getElementById(id);
  var rows = '';
  var visible = (ST.showMore && ST.showMore[id]) ? OB_MAX_ROWS : OB_BASE_ROWS;
  for (var i = 0; i < visible; i++) {
    var ad = ads[i];
    if (!ad && i >= OB_BASE_ROWS) break; // sin relleno vacio en las filas expandidas
    if (ad) {
      var cls = 'ob-row' + (i === 0 ? ' ' + bestCls : '');
      var rnk = '<span class="rank ' + (i === 0 ? 'n1' : '') + '">' + (i + 1) + '</span>';
      var lims = fmtM(ad.minVES) + '–' + fmtM(ad.price * ad.avail);
      var lvlColor = ['','#CD7F32','#A8B8C8','#F0B90B'][ad.vipLevel] || '#F0B90B';
      var badgeHtml = '';
      if (ad.badges && ad.badges[0]) {
        if (ad.badges[0] === 'Block') {
          badgeHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 100 100" style="margin-left:5px;flex-shrink:0;vertical-align:middle" title="Block vip'+ad.vipLevel+'"><defs><linearGradient id="dg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#7c3aed"/></linearGradient></defs><polygon points="50,5 90,30 90,70 50,95 10,70 10,30" fill="url(#dg)" stroke="#a855f7" stroke-width="3"/><polyline points="32,52 44,64 68,38" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          badgeHtml = '<span style="margin-left:5px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:'+lvlColor+';color:#000;font-size:13px;font-weight:900;flex-shrink:0;line-height:1" title="PRO vip'+ad.vipLevel+'">✓</span>';
        }
      }
      var availStr = ad.avail >= 1000
        ? (ad.avail / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
        : Math.round(ad.avail).toLocaleString('es-VE');
      var disp = ST.availDisp && ST.availDisp[id];
      var arrowHtml = availArrowHtml(disp && disp[ad.advNo]);
      var popupHtml = availPopupHtml(disp && disp[ad.advNo]);
      var meCls = ad.merchant === MY_NICK ? ' me' : '';
      rows += '<div class="' + cls + '">' + rnk +
        '<span class="merch' + meCls + '" style="display:flex;align-items:center;gap:0" title="' + esc(ad.merchant) + '">' + esc(ad.merchant) + badgeHtml + '</span>' +
        '<span class="lim-c" style="font-variant-numeric:tabular-nums" title="' + Math.round(ad.avail) + ' USDT disponibles"><span class="avail-num">' + arrowHtml + availStr + '</span></span>' +
        '<span class="price-c">' + fmtP(ad.price) + '</span>' +
        '<span class="lim-c' + pisadoCls(ads, i) + '">' + lims + '<span class="lim-amount">' + availStr + ' USDT</span></span>' +
        popupHtml +
      '</div>';
    } else {
      rows += '<div class="ob-row" style="opacity:0.18">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="merch" style="color:var(--text-3)">—</span>' +
        '<span class="lim-c">—</span>' +
        '<span class="price-c">—</span>' +
        '<span class="lim-c">—</span>' +
      '</div>';
    }
  }
  wrap.innerHTML = rows;
  updateShowMoreBtn(id, ads.length);
}

// Muestra/oculta el boton "ver mas" segun cuantos comercios hay tras el visible base.
function updateShowMoreBtn(id, total) {
  var btn = document.getElementById('more-' + id);
  if (!btn) return;
  var expanded = !!(ST.showMore && ST.showMore[id]);
  if (!expanded && total <= OB_BASE_ROWS) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = expanded ? '▲ Ver menos' : '▼ Ver ' + Math.min(OB_MAX_ROWS - OB_BASE_ROWS, total - OB_BASE_ROWS) + ' comercios más';
}
function toggleShowMore(id) {
  ST.showMore = ST.showMore || {};
  ST.showMore[id] = !ST.showMore[id];
  renderAll();
}

// ── Buy Section Render ────────────────────────────────
function renderBuySection(ads) {
  var wrap = document.getElementById('ob-buy');
  if (!wrap) return;
  var rows = '';
  var visible = (ST.showMore && ST.showMore['ob-buy']) ? OB_MAX_ROWS : OB_BASE_ROWS;
  for (var i = 0; i < visible; i++) {
    var ad = ads[i];
    if (!ad && i >= OB_BASE_ROWS) break;
    if (ad) {
      var cls = 'ob-row' + (i === 0 ? ' best-buy-asc' : '');
      var rnk = '<span class="rank ' + (i === 0 ? 'n1' : '') + '">' + (i + 1) + '</span>';
      var lims = fmtM(ad.minVES) + '–' + fmtM(ad.price * ad.avail);
      var lvlColor = ['','#CD7F32','#A8B8C8','#F0B90B'][ad.vipLevel] || '#F0B90B';
      var badgeHtml = '';
      if (ad.badges && ad.badges[0]) {
        if (ad.badges[0] === 'Block') {
          badgeHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 100 100" style="margin-left:5px;flex-shrink:0;vertical-align:middle" title="Block vip'+ad.vipLevel+'"><defs><linearGradient id="dg-buy" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#7c3aed"/></linearGradient></defs><polygon points="50,5 90,30 90,70 50,95 10,70 10,30" fill="url(#dg-buy)" stroke="#a855f7" stroke-width="3"/><polyline points="32,52 44,64 68,38" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          badgeHtml = '<span style="margin-left:5px;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:'+lvlColor+';color:#000;font-size:13px;font-weight:900;flex-shrink:0;line-height:1" title="PRO vip'+ad.vipLevel+'">✓</span>';
        }
      }
      var availStr = ad.avail >= 1000
        ? (ad.avail / 1000).toLocaleString('es-VE', {maximumFractionDigits: 1}) + 'k'
        : Math.round(ad.avail).toLocaleString('es-VE');
      var disp = ST.availDisp && ST.availDisp['ob-buy'];
      var arrowHtml = availArrowHtml(disp && disp[ad.advNo]);
      var popupHtml = availPopupHtml(disp && disp[ad.advNo]);
      var meCls = ad.merchant === MY_NICK ? ' me' : '';
      rows += '<div class="' + cls + '">' + rnk +
        '<span class="merch' + meCls + '" style="display:flex;align-items:center;gap:0" title="' + esc(ad.merchant) + '">' + esc(ad.merchant) + badgeHtml + '</span>' +
        '<span class="lim-c" style="font-variant-numeric:tabular-nums" title="' + Math.round(ad.avail) + ' USDT disponibles"><span class="avail-num">' + arrowHtml + availStr + '</span></span>' +
        '<span class="price-c g">' + fmtP(ad.price) + '</span>' +
        '<span class="lim-c' + pisadoCls(ads, i) + '">' + lims + '<span class="lim-amount">' + availStr + ' USDT</span></span>' +
        popupHtml +
      '</div>';
    } else {
      rows += '<div class="ob-row" style="opacity:0.18">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="merch" style="color:var(--text-3)">—</span>' +
        '<span class="lim-c">—</span>' +
        '<span class="price-c">—</span>' +
        '<span class="lim-c">—</span>' +
      '</div>';
    }
  }
  wrap.innerHTML = rows;
  updateShowMoreBtn('ob-buy', ads.length);
}

function renderBuySpread() {
  // sellPrice = precio del verde (merchant vende USDT, usuario compra del usuario aquí)
  // buyPrice  = precio del libro de compradores (lo que pagarían por USDT si hubiera que reponerlo)
  var sellPrice = ST.buyAds[0]     ? ST.buyAds[0].price     : null; // Keria23: precio verde
  var buyPrice  = ST.smallAds[0]   ? ST.smallAds[0].price   : null; // sección rojo (compra 30k): precio referencia

  var netEl    = document.getElementById('bs-net');
  var sellEff  = document.getElementById('bs-sell-eff');
  var sellRef  = document.getElementById('bs-sell-ref');
  var buyRef   = document.getElementById('bs-buy-ref');
  if (!netEl) return;

  if (!sellPrice || !buyPrice) {
    netEl.textContent   = '—'; netEl.className = 'bs-val';
    if (sellEff) sellEff.textContent = '—';
    if (sellRef) sellRef.textContent = '—';
    if (buyRef)  buyRef.textContent  = '—';
    var p0 = document.getElementById('bs-pill');
    if (p0) { p0.textContent = 'Sin datos'; p0.className = 'bsc-pill'; p0.style.cssText = 'background:var(--surf-2);color:var(--text-3);border:1px solid var(--border)'; }
    var a0 = document.getElementById('bs-net-abs');
    if (a0) a0.textContent = '';
    return;
  }

  var c = CFG.commission / 100;
  // Vendo en el verde: recibo sellPrice, Binance cobra c → recibo efectivo = sellPrice × (1−c)
  // Compro via libro: costo buyPrice, Binance cobra c → costo efectivo = buyPrice × (1+c)
  var effectiveSell = sellPrice * (1 - c);
  var effectiveBuy  = buyPrice  * (1 + c);
  var netAbs        = effectiveSell - effectiveBuy;
  var netPct        = netAbs / sellPrice * 100;
  var isGood        = netPct >= CFG.spreadThr;

  netEl.textContent = netPct.toFixed(3) + '%';
  netEl.className   = 'bs-val' + (isGood ? '' : ' bs-red');
  netEl.style.color = '';

  if (sellEff) sellEff.textContent = fmt(effectiveSell) + fiatSuf();
  if (sellRef) sellRef.textContent = fmt(sellPrice) + fiatSuf();
  if (buyRef)  buyRef.textContent  = fmt(buyPrice)  + fiatSuf();

  var absEl = document.getElementById('bs-net-abs');
  if (absEl) absEl.textContent = '≈ ' + fmt(netAbs) + fiatSuf() + '/USDT';
  var pill = document.getElementById('bs-pill');
  if (pill) {
    pill.className = 'bsc-pill';
    if (netPct <= 0) { pill.textContent = '⚠ Negativo'; pill.style.cssText = 'background:var(--red-d);color:var(--red);border:1px solid var(--red-b)'; }
    else if (isGood) { pill.textContent = '🟡 Oportunidad'; pill.style.cssText = 'background:var(--gold-d);color:var(--gold);border:1px solid var(--gold-b)'; }
    else { pill.textContent = 'Bajo umbral'; pill.style.cssText = 'background:var(--surf-2);color:var(--text-3);border:1px solid var(--border)'; }
  }

  var sellInp = document.getElementById('cfg-bot-sell');
  if (sellInp && sellPrice) sellInp.placeholder = 'sug. ' + Math.round(sellPrice);
}

// ── Alertas ───────────────────────────────────────────
function checkAlerts() {
  var now = Date.now();
  var cMay = credibleMay(), cSmall = credibleSmall();
  var bestMay   = cMay   ? cMay.price   : null;  // solo mayoristas creibles (>=2000 USDT)
  var bestSmall = cSmall ? cSmall.price : null;

  if (!bestMay) return;

  // Spread
  if (bestSmall) {
    var spread    = (bestMay - bestSmall) / bestMay * 100;
    var spreadNet = spread - CFG.commission;
    var evalSpread = CFG.commission > 0 ? spreadNet : spread;
    var netLabel   = CFG.commission > 0 ? ' (neto ' + spreadNet.toFixed(3) + '%)' : '';
    if (evalSpread >= CFG.spreadThr) {
      if (!COOLDOWN.spread || now - COOLDOWN.spread > COOLDOWN_MS) {
        COOLDOWN.spread = now;
        addAlert('spread',
          '💰 Spread ' + spread.toFixed(3) + '%' + netLabel + ' — OPORTUNIDAD',
          'Mayorista: ' + fmt(bestMay) + fiatSuf() + ' (' + esc(cMay.merchant) + ') → Compra: ' + fmt(bestSmall) + fiatSuf() + ' · Dif: ' + fmt(bestMay - bestSmall) + fiatSuf() + '/USDT'
        );
        push('Spread P2P ' + spread.toFixed(3) + '%', 'Vende a ' + fmt(bestMay) + fiatSuf() + ' — compra ref. ' + fmt(bestSmall) + fiatSuf());
      }
    }
  }

  // Sobrecomprado / debilidad
  if (ST.priceHist.length > 1) {
    var ref10 = null;
    for (var i = ST.priceHist.length - 1; i >= 0; i--) {
      var age10 = now - ST.priceHist[i].ts;
      // Referencia valida solo si es de ~10 min (no de un hueco): ignora si tiene >18 min.
      if (age10 >= 9 * 60000) { if (age10 <= 18 * 60000) ref10 = ST.priceHist[i].price; break; }
    }
    if (ref10 !== null) {
      var chg = (bestMay - ref10) / ref10 * 100;
      if (chg > CFG.overboughtThr) {
        if (!COOLDOWN.ob || now - COOLDOWN.ob > COOLDOWN_MS) {
          COOLDOWN.ob = now;
          addAlert('overbought', '🔴 Mercado sobrecomprado', '+' + chg.toFixed(3) + '% en 10 min · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Sobrecomprado P2P', '+' + chg.toFixed(3) + '% en 10 min');
        }
      } else { COOLDOWN.ob = 0; }

      if (chg < -CFG.weaknessThr) {
        if (!COOLDOWN.wk || now - COOLDOWN.wk > COOLDOWN_MS) {
          COOLDOWN.wk = now;
          addAlert('weakness', '🔵 Debilidad en el mercado', chg.toFixed(3) + '% en 10 min · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Debilidad P2P', chg.toFixed(3) + '% en 10 min');
        }
      } else { COOLDOWN.wk = 0; }
    }
  }

  // Tendencia sostenida (~1h): cambio grande confirmado a mitad de ventana (filtra picos sueltos)
  if (ST.priceHist.length > 2) {
    var ref60 = null, ref30 = null;
    for (var k = ST.priceHist.length - 1; k >= 0; k--) {
      var ageT = now - ST.priceHist[k].ts;
      if (ref30 === null && ageT >= 25 * 60000 && ageT <= 40 * 60000) ref30 = ST.priceHist[k].price;
      if (ref60 === null && ageT >= 50 * 60000 && ageT <= 75 * 60000) ref60 = ST.priceHist[k].price;
      if (ref30 !== null && ref60 !== null) break;
    }
    if (ref60 !== null && ref30 !== null) {
      var chg60 = (bestMay - ref60) / ref60 * 100;
      var chg30 = (bestMay - ref30) / ref30 * 100;
      var TREND_CD = 20 * 60000;
      if (Math.abs(chg60) >= CFG.sustainThr && Math.sign(chg30) === Math.sign(chg60)) {
        if (!COOLDOWN.tr || now - COOLDOWN.tr > TREND_CD) {
          COOLDOWN.tr = now;
          var upT = chg60 > 0;
          addAlert(upT ? 'overbought' : 'weakness',
            upT ? '📈 Tendencia alcista sostenida' : '📉 Tendencia bajista sostenida',
            (upT ? '+' : '') + chg60.toFixed(2) + '% en 1h · Precio actual: ' + fmt(bestMay) + fiatSuf());
          push('Tendencia P2P', (upT ? '+' : '') + chg60.toFixed(2) + '% en 1h');
        }
      } else { COOLDOWN.tr = 0; }
    }
  }
}

function addAlert(type, title, desc) {
  var ts = new Date().toLocaleTimeString('es-VE');
  ST.alerts.unshift({ type: type, title: title, desc: desc, ts: ts });
  if (ST.alerts.length > 60) ST.alerts.pop();
  renderAlerts();
}

function renderAlerts() {
  var list  = document.getElementById('alert-list');
  var badge = document.getElementById('bell-badge');
  if (!ST.alerts.length) {
    list.innerHTML = '<div class="empty">Sin alertas</div>';
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  badge.textContent = ST.alerts.length > 9 ? '9+' : ST.alerts.length;
  var icons = { spread: '🟡', overbought: '🔴', weakness: '🔵', info: 'ℹ️' };
  list.innerHTML = ST.alerts.slice(0, 25).map(function(a) {
    return '<div class="al ' + a.type + '">' +
      '<span class="al-icon">' + (icons[a.type] || '•') + '</span>' +
      '<div class="al-body"><div class="al-title">' + a.title + '</div><div class="al-desc">' + a.desc + '</div></div>' +
      '<span class="al-time">' + a.ts + '</span></div>';
  }).join('');
}

function clearAlerts() { ST.alerts = []; COOLDOWN = {}; renderAlerts(); }

// ── Web Push (notificaciones del sistema, app cerrada) ─
var PUSH = { sub: null };
function b64ToU8(base64) {
  var pad = '='.repeat((4 - base64.length % 4) % 4);
  var b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(b), arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function updPushBtn() {
  var b = document.getElementById('btn-push');
  if (!b) return;
  var supported = ('serviceWorker' in navigator) && ('PushManager' in window);
  if (!supported) { b.textContent = 'No soportado'; b.disabled = true; return; }
  b.textContent = PUSH.sub ? '✓ Activado' : 'Activar';
}
async function refreshPushState() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { updPushBtn(); return; }
    var reg = await navigator.serviceWorker.ready;
    PUSH.sub = await reg.pushManager.getSubscription();
  } catch(e) { PUSH.sub = null; }
  updPushBtn();
}
async function togglePush() {
  var b = document.getElementById('btn-push');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Tu navegador no soporta push'); return; }
  if (!SESSION.token) { toast('Inicia sesión primero'); return; }
  try {
    var reg = await navigator.serviceWorker.ready;
    if (PUSH.sub) {
      var endpoint = PUSH.sub.endpoint;
      await PUSH.sub.unsubscribe().catch(function(){});
      await botCallWorker('/push-unsubscribe', { endpoint: endpoint }).catch(function(){});
      PUSH.sub = null; updPushBtn(); toast('Push desactivado');
      return;
    }
    if (Notification.permission !== 'granted') {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Permiso denegado'); return; }
    }
    if (b) b.textContent = 'Activando...';
    var kd = await botCallWorker('/push-key');
    if (!kd || !kd.key) { toast('Push no configurado en el servidor'); updPushBtn(); return; }
    PUSH.sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(kd.key) });
    await botCallWorker('/push-subscribe', { sub: PUSH.sub.toJSON() });
    updPushBtn(); toast('✓ Push activado');
    botCallWorker('/push-test').catch(function(){});
  } catch(e) { toast('⚠ ' + e.message); updPushBtn(); }
}

// ── Notificaciones ────────────────────────────────────
function reqNotif() {
  if (!('Notification' in window)) { document.getElementById('notif-st').textContent = 'No soportado'; return; }
  Notification.requestPermission().then(updNotifSt);
}
function updNotifSt() {
  var el = document.getElementById('notif-st');
  if (!('Notification' in window)) { el.textContent = ''; return; }
  el.textContent = Notification.permission === 'granted' ? '✓' : Notification.permission === 'denied' ? '✗' : '?';
}
// Silencio nocturno del lado del CLIENTE: con la app abierta el servidor cede el
// monitor (heartbeat) y quien alerta es el cliente — debe respetar el mismo horario.
function inQuietNow() {
  var s = CFG.monQuietStart, e = CFG.monQuietEnd;
  if (!s || !e || s === e) return false;
  function toMin(hm) { var p = String(hm).split(':'); return (+p[0] || 0) * 60 + (+p[1] || 0); }
  var d = new Date(), cur = d.getHours() * 60 + d.getMinutes();
  var sm = toMin(s), em = toMin(e);
  return sm < em ? (cur >= sm && cur < em) : (cur >= sm || cur < em); // soporta franja nocturna
}
function push(title, body) {
  if (inQuietNow()) return; // 🌙 silencio nocturno: ni Telegram ni notificacion
  if (Notification.permission === 'granted') new Notification('🟡 P2P — ' + title, { body: body });
  sendTelegram('<b>🟡 P2P — ' + title + '</b>\n' + body);
}
function testNotif() {
  if (Notification.permission !== 'granted') { reqNotif(); return; }
  push('Test', 'Notificaciones funcionando'); toast('Test enviado');
}

// ── UI toggles ────────────────────────────────────────
function toggleAlertDropdown(e) {
  e.stopPropagation();
  var d = document.getElementById('alert-dropdown');
  if (d.style.display === 'flex') { d.style.display = 'none'; return; }
  d.style.display = 'flex';
}

function toggleAlertConfig(e) {
  e.stopPropagation();
  var c = document.getElementById('alert-config');
  if (c) c.style.display = c.style.display === 'none' ? 'block' : 'none';
}

function toggleBotGear(e) {
  e.stopPropagation();
  var p = document.getElementById('bot-gear-popup');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

function toggleObGear(e) {
  e.stopPropagation();
  var p = document.getElementById('ob-gear-popup');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

// ── Presence watchdog ─────────────────────────────────
var ACTIVITY = {
  lastActivity: Date.now(),
  checkTimer: null,
  countdownTimer: null,
  enabled: true,
  INACTIVE_MS: 5 * 60 * 1000,
  GRACE_MS: 60 * 1000,
  CHECK_MS: 30 * 1000
};

function loadActivityGuard() {
  try {
    var v = localStorage.getItem('p2p_activity_guard');
    if (v === 'false') ACTIVITY.enabled = false;
  } catch(e) {}
  updateActivityBtn();
}

function updateActivityBtn() {
  var b = document.getElementById('btn-activity');
  if (!b) return;
  if (ACTIVITY.enabled) {
    b.textContent = '🛡️';
    b.style.opacity = '1';
    b.title = 'Alertas de actividad activas (click para desactivar)';
  } else {
    b.textContent = '🛡️';
    b.style.opacity = '0.35';
    b.title = 'Alertas de actividad DESACTIVADAS (click para activar)';
  }
}

function toggleActivityGuard() {
  ACTIVITY.enabled = !ACTIVITY.enabled;
  try { localStorage.setItem('p2p_activity_guard', ACTIVITY.enabled ? 'true' : 'false'); } catch(e) {}
  updateActivityBtn();
  if (!ACTIVITY.enabled) hidePresenceModal();
  toast(ACTIVITY.enabled ? 'Apagado por inactividad: ON' : 'Apagado por inactividad: OFF');
}

function bumpActivity() { ACTIVITY.lastActivity = Date.now(); }

['mousemove','keydown','touchstart','click','scroll'].forEach(function(ev){
  document.addEventListener(ev, bumpActivity, { passive: true });
});

function startActivityWatcher() {
  bumpActivity();
  if (ACTIVITY.checkTimer) clearInterval(ACTIVITY.checkTimer);
  ACTIVITY.checkTimer = setInterval(activityCheck, ACTIVITY.CHECK_MS);
}

function stopActivityWatcher() {
  if (ACTIVITY.checkTimer) { clearInterval(ACTIVITY.checkTimer); ACTIVITY.checkTimer = null; }
  hidePresenceModal();
}

function activityCheck() {
  if (!BOT.running) return;
  if (!ACTIVITY.enabled) return;
  var modal = document.getElementById('presence-modal');
  if (modal && modal.style.display === 'flex') return;
  if (Date.now() - ACTIVITY.lastActivity >= ACTIVITY.INACTIVE_MS) showPresenceModal();
}

function showPresenceModal() {
  var m = document.getElementById('presence-modal');
  if (!m) return;
  m.style.display = 'flex';
  try { new Audio('data:audio/wav;base64,UklGRl9vAAAAAQEBAAEBAAEBAAEBAAEBAAEBAAEB').play(); } catch(e) {}
  var deadline = Date.now() + ACTIVITY.GRACE_MS;
  var cd = document.getElementById('presence-countdown');
  function tick() {
    var rem = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (cd) cd.textContent = rem + 's';
    if (rem <= 0) {
      hidePresenceModal();
      botLog('🛑 Bot detenido por inactividad (sin respuesta al chequeo de presencia)', '#E24B4A');
      sendTelegram('🛑 P2P Bot detenido: inactividad detectada — anuncio pausado');
      botToggle();
    }
  }
  tick();
  ACTIVITY.countdownTimer = setInterval(tick, 1000);
}

function hidePresenceModal() {
  var m = document.getElementById('presence-modal');
  if (m) m.style.display = 'none';
  if (ACTIVITY.countdownTimer) { clearInterval(ACTIVITY.countdownTimer); ACTIVITY.countdownTimer = null; }
}

function confirmPresence() {
  bumpActivity();
  hidePresenceModal();
  botLog('✓ Presencia confirmada', '#8b949e');
}

document.addEventListener('click', function(e) {
  var d = document.getElementById('alert-dropdown');
  if (d && d.style.display === 'flex' && !d.contains(e.target) && e.target.id !== 'btn-bell' && !document.getElementById('btn-bell').contains(e.target)) {
    d.style.display = 'none';
  }
  [['bot-gear-popup','bot-gear-btn'],['ob-gear-popup','ob-gear-btn']].forEach(function(pair) {
    var gp = document.getElementById(pair[0]);
    var gb = document.getElementById(pair[1]);
    if (gp && gp.style.display !== 'none' && !gp.contains(e.target) && gb && !gb.contains(e.target)) {
      gp.style.display = 'none';
    }
  });
});

// ── Auto-Repricing Bot ────────────────────────────────
var BOT = {
  running: false,
  timer: null,
  adNumber: null,
  myNick: null,
  basePrice: null,
  ceiling: null,
  currentPrice: null,
  myMinLimit: null,
  lastReprice: 0,
  cycles: 0,
  appliedMinLimit: 0,
  cachedAd: null,
  cachedAdAt: 0,
  adPayTypes: []
};

var BOT_CFG = {
  url: 'https://kisushotto-site.vercel.app/api/binance-bot',
  token: '',
  adNo: '',
  increment: 0.001,
  maxGap: 1.0,
  limitThreshold: 10000,
  sellPrice: 0,
  minSpread: 0.5,
  minLimit: 0,
  myNick: '',
  payMethods: [] // ids elegidos para el anuncio (vacio = no tocar sus metodos)
};

// BDV en la UI = Banco de Venezuela + Bank Transfer (el usuario los usa juntos)
var BOT_PAY_EXPAND = { BancoDeVenezuela: ['BancoDeVenezuela', 'BANK'] };
function botExpandPays(ids) {
  var out = [];
  (ids || []).forEach(function (id) {
    (BOT_PAY_EXPAND[id] || [id]).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); });
  });
  return out;
}

function stepInput(id, dir) {
  const el = document.getElementById(id);
  const step = parseFloat(el.step) || 1;
  const min  = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const max  = el.max !== '' ? parseFloat(el.max) :  Infinity;
  const cur  = parseFloat(el.value) || 0;
  const dec  = (step.toString().split('.')[1] || '').length;
  el.value   = Math.max(min, Math.min(max, parseFloat((cur + dir * step).toFixed(dec))));
  el.dispatchEvent(new Event('input'));
}

function saveBotConfig() {
  BOT_CFG.adNo           = document.getElementById('cfg-bot-adsel').value;
  BOT_CFG.myNick         = document.getElementById('cfg-bot-nick').value.trim();
  BOT_CFG.increment      = parseFloat(document.getElementById('cfg-bot-inc').value)     || 0.001;
  BOT_CFG.maxGap         = parseFloat(document.getElementById('cfg-bot-gap').value)     || 1.0;
  BOT_CFG.limitThreshold = parseFloat(document.getElementById('cfg-bot-thr').value)     || 10000;
  BOT_CFG.sellPrice      = parseFloat(document.getElementById('cfg-bot-sell').value)    || 0;
  BOT_CFG.minSpread      = parseFloat(document.getElementById('cfg-bot-spread').value)  || 0.5;
  BOT_CFG.minLimit       = parseFloat(document.getElementById('cfg-bot-minlimit').value) || 0;
  BOT_CFG.payMethods     = readBotPayChecks();
  localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
  // Save Telegram from popup inputs
  TG.token  = document.getElementById('cfg-tg-token').value.trim();
  TG.chatId = document.getElementById('cfg-tg-chat').value.trim();
  localStorage.setItem('p2p_tg', JSON.stringify(TG));
  botUpdateCeiling();
  // Si el bot ya corre en el servidor, empujar la config en caliente (limite, spread, etc.).
  if (BOT.running) botCallWorker('/bot-config', { config: botServerConfig() }).catch(function(){});
  var st = document.getElementById('bot-cfg-st');
  st.textContent = '✓ Guardado'; st.style.color = '#1D9E75';
  var tgSt = document.getElementById('tg-st');
  if (tgSt) { tgSt.textContent = (TG.token && TG.chatId) ? '✓' : ''; }
  saveUserSettings();
}

// Checkboxes de metodos de pago del anuncio (lista VES; el bot siempre es VES)
function renderBotPayChecks() {
  var box = document.getElementById('bot-paymethods');
  if (!box) return;
  var sel = BOT_CFG.payMethods || [];
  box.innerHTML = PAY_METHODS_BY_FIAT.VES.map(function (m) {
    var on = sel.indexOf(m.id) !== -1 ? ' checked' : '';
    return '<label class="pay-chk"><input type="checkbox" value="' + m.id + '"' + on + '>' + m.label + '</label>';
  }).join('');
}
function readBotPayChecks() {
  var box = document.getElementById('bot-paymethods');
  if (!box) return BOT_CFG.payMethods || [];
  return Array.prototype.filter.call(box.querySelectorAll('input:checked'), function () { return true; })
    .map(function (c) { return c.value; });
}
function samePaySet(a, b) {
  a = (a || []).slice().sort(); b = (b || []).slice().sort();
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function botApplyMethods(silent, skipIfSame) {
  var ids = readBotPayChecks();
  var st = document.getElementById('bot-cfg-st');
  if (!ids.length) { if (!silent && st) { st.textContent = 'Marca al menos un método'; st.style.color = 'var(--red)'; } return false; }
  var adNo = BOT.adNumber || BOT_CFG.adNo;
  if (!adNo) { if (!silent && st) { st.textContent = 'Configura el anuncio primero'; st.style.color = 'var(--red)'; } return false; }
  var pays = botExpandPays(ids);
  // Si el anuncio ya tiene exactamente esos metodos, no gastar requests (getDetail + update).
  if (skipIfSame && samePaySet(pays, BOT.adPayTypes)) return true;
  botLog('💳 Aplicando métodos: ' + ids.map(payLabel).join(', '), '#58A6FF');
  try {
    var data = await botCallWorker('/update-methods', { advNo: adNo, payTypes: pays });
    if (data.code && data.code !== '000000') throw new Error(data.msgDetail || data.message || data.msg || 'código ' + data.code);
    BOT.adPayTypes = pays.filter(function (id) { return GENERIC_PAY_IDS.indexOf(id) === -1; });
    updateBotPayBadge();
    BOT.cachedAd = null; BOT.cachedAdAt = 0;
    botLog('✓ Métodos actualizados en el anuncio', '#1D9E75');
    if (!silent && st) { st.textContent = '✓ Métodos aplicados'; st.style.color = 'var(--green)'; }
    return true;
  } catch (e) {
    botLog('⚠ No se pudieron aplicar métodos: ' + e.message, '#F6465D');
    if (!silent && st) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)'; }
    return false;
  }
}

function loadBotConfig() {
  try {
    var s = localStorage.getItem('p2p_bot_cfg');
    if (!s) { renderBotPayChecks(); return; }
    Object.assign(BOT_CFG, JSON.parse(s));
    BOT_CFG.url = 'https://kisushotto-site.vercel.app/api/binance-bot'; // fija (interna)
    var _sel = document.getElementById('cfg-bot-adsel');
    if (BOT_CFG.adNo && !Array.prototype.some.call(_sel.options, function(o){ return o.value === BOT_CFG.adNo; })) {
      var _o = document.createElement('option'); _o.value = BOT_CFG.adNo; _o.textContent = 'Ad ' + BOT_CFG.adNo; _sel.appendChild(_o);
    }
    _sel.value = BOT_CFG.adNo || '';
    document.getElementById('cfg-bot-nick').value     = BOT_CFG.myNick || '';
    document.getElementById('cfg-bot-inc').value      = BOT_CFG.increment;
    document.getElementById('cfg-bot-gap').value      = BOT_CFG.maxGap;
    document.getElementById('cfg-bot-thr').value      = BOT_CFG.limitThreshold;
    document.getElementById('cfg-bot-sell').value     = BOT_CFG.sellPrice || '';
    document.getElementById('cfg-bot-spread').value   = BOT_CFG.minSpread;
    document.getElementById('cfg-bot-minlimit').value = BOT_CFG.minLimit || '';
    renderBotPayChecks();
    botUpdateCeiling();
  } catch(e) {}
}

function updateCommissionLabels() {
  var c = CFG.commission || 0;
  ['ob-commission-label','bot-commission-label'].forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    if (c > 0) {
      el.textContent = 'COMISIÓN ' + c + '%';
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

function botUpdateCeiling() {
  var sell   = parseFloat(document.getElementById('cfg-bot-sell').value)   || 0;
  var spread = parseFloat(document.getElementById('cfg-bot-spread').value) || 0.5;
  var el     = document.getElementById('bot-ceiling');
  if (sell > 0) {
    var ceiling = sell * (1 - (spread + (CFG.commission || 0)) / 100);
    BOT.ceiling = ceiling;
    if (el) el.textContent = ceiling.toFixed(3) + ' Bs';
    updateBotPriceColor();
  } else {
    BOT.ceiling = null;
    if (el) el.textContent = '—';
  }
}

async function botCallWorker(path, body) {
  if (!SESSION.token) throw new Error('Inicia sesión primero');
  // 20s: rutas como /update-limit hacen 2 llamadas a Binance + cold start; con el
  // default de 8s el cliente abortaba con "Timeout" aunque el servidor iba bien.
  var r = await fetchRetry(BOT_CFG.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SESSION.token },
    body: JSON.stringify({ path: path, params: body || {} })
  }, 20000);
  var data = await r.json().catch(function() { return {}; });
  if (!r.ok) throw new Error('Worker ' + r.status + (data.error ? ': ' + data.error : ''));
  return data;
}

async function loadMyAds() {
  var sel = document.getElementById('cfg-bot-adsel');
  var st  = document.getElementById('bot-cfg-st');
  if (!SESSION.token) { if (st) { st.textContent = 'Inicia sesión primero'; st.style.color = '#E24B4A'; } return; }
  if (st) { st.textContent = 'Cargando anuncios...'; st.style.color = '#555'; }
  try {
    var data = await botCallWorker('/my-ads');
    var ads = Array.isArray(data.data) ? data.data
            : (data.data && Array.isArray(data.data.data)) ? data.data.data : [];
    sel.innerHTML = '<option value="">Auto-detectar</option>';
    ads.forEach(function(a) {
      var no    = String(a.adNumber || a.advNo);
      var price = a.price != null ? (+a.price).toFixed(3) : '?';
      var avail = parseFloat(a.surplusAmount || a.tradableQuantity || a.remainQuantity || 0);
      var live  = a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1 || a.adStatus === 1;
      var o = document.createElement('option');
      o.value = no;
      o.textContent = (a.tradeType || '') + ' ' + price + ' · ' + Math.round(avail) + ' USDT' + (live ? '' : ' (pausado)');
      sel.appendChild(o);
    });
    if (BOT_CFG.adNo && !Array.prototype.some.call(sel.options, function(o){ return o.value === BOT_CFG.adNo; })) {
      var miss = document.createElement('option'); miss.value = BOT_CFG.adNo; miss.textContent = 'Ad ' + BOT_CFG.adNo; sel.appendChild(miss);
    }
    sel.value = BOT_CFG.adNo || '';
    var nickEl = document.getElementById('cfg-bot-nick');
    var detected = ads.map(function(a){ return a.advertiserNickName || a.nickName || (a.advertiser && a.advertiser.nickName) || a.merchantNickName; }).find(Boolean);
    if (detected && nickEl && !nickEl.value.trim()) {
      nickEl.value = detected;
      BOT_CFG.myNick = detected;
      localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
    }
    if (st) { st.textContent = ads.length + ' anuncio(s)'; st.style.color = '#1D9E75'; }
  } catch (e) {
    if (st) { st.textContent = e.message; st.style.color = '#E24B4A'; }
  }
}

function onAdSelect() {
  BOT_CFG.adNo = document.getElementById('cfg-bot-adsel').value;
  localStorage.setItem('p2p_bot_cfg', JSON.stringify(BOT_CFG));
  saveUserSettings();
}

async function botGetMyAd(allowPaused) {
  var data = await botCallWorker('/my-ads');
  var ads = Array.isArray(data.data) ? data.data
          : Array.isArray(data.data && data.data.data) ? data.data.data
          : null;
  if (!ads || !ads.length) {
    botLog('Raw API: ' + JSON.stringify(data).substring(0, 200), '#888');
    throw new Error('Sin anuncios (ver log)');
  }
  // Si hay Ad Number configurado, buscar ese exacto
  if (BOT_CFG.adNo) {
    var byId = ads.find(function(a) {
      return String(a.adNumber || a.advNo) === BOT_CFG.adNo;
    });
    if (!byId) throw new Error('Ad ' + BOT_CFG.adNo + ' no encontrado en la lista');
    var isLiveById = byId.advStatus === 'LIVE' || byId.advStatus === 'ONLINE' || byId.advStatus === 1
                  || byId.status === 'LIVE' || byId.adStatus === 1;
    if (!isLiveById && !allowPaused) return null; // pausado manualmente
    // Detectar fondos insuficientes: menos de 100 USDT no permite editar precio
    var surplusUsdt = parseFloat(byId.surplusAmount || byId.tradableQuantity || byId.remainQuantity || 0);
    if (surplusUsdt > 0 && surplusUsdt < 100) byId.__noFunds = true;
    return byId;
  }
  // Auto-detección: primer anuncio BUY USDT/VES activo
  return ads.find(function(a) {
    var isBuy  = a.tradeType === 'BUY';
    var isUsdt = a.asset === 'USDT' || a.cryptoCurrency === 'USDT';
    var isVes  = a.fiatUnit === 'VES' || a.fiatCurrency === 'VES' || a.fiat === 'VES';
    var isLive = a.advStatus === 'LIVE' || a.advStatus === 'ONLINE' || a.advStatus === 1
              || a.status === 'LIVE' || a.adStatus === 1;
    return isBuy && isUsdt && isVes && isLive;
  }) || null;
}

function updateManualTotal() {
  var qty   = parseFloat(document.getElementById('manual-qty').value) || 0;
  var price = BOT.currentPrice || parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
  var el    = document.getElementById('manual-total');
  el.textContent = (qty && price) ? fmt(price * qty) + ' Bs' : '—';
}

function updateManualBalance() {
  var el = document.getElementById('manual-balance');
  if (!el) return;
  var ad = BOT.cachedAd;
  if (!ad) { el.textContent = ''; return; }
  var usdt = parseFloat(ad.surplusAmount || ad.tradableQuantity || ad.remainQuantity || 0);
  if (!usdt) { el.textContent = ''; return; }
  var price = BOT.currentPrice || parseFloat(document.getElementById('cfg-bot-sell').value) || 0;
  var ves = price ? '· ' + fmt(usdt * price) + ' Bs' : '';
  el.textContent = '(' + usdt.toFixed(2) + ' USDT ' + ves + ')';
}

async function manualSetQty() {
  var qty = parseFloat(document.getElementById('manual-qty').value);
  var st = document.getElementById('manual-st');
  if (!qty || qty <= 0) { st.textContent = 'Ingresa una cantidad válida'; st.style.color = 'var(--red)'; return; }
  var adNo = BOT.adNumber || BOT_CFG.adNo;
  if (!adNo) { st.textContent = 'Configura el Ad Number primero'; st.style.color = 'var(--red)'; return; }
  st.textContent = 'Aplicando cantidad...'; st.style.color = 'var(--text-3)';
  try {
    var data = await botCallWorker('/update-quantity', { advNo: adNo, totalAmount: qty });
    if (data.code && data.code !== '000000') throw new Error(data.msgDetail || data.msg || data.message || 'código ' + data.code);
    botLog('✎ Cantidad manual → ' + qty + ' USDT', '#58A6FF');
    BOT.cachedAd = null;
    BOT.cachedAdAt = 0;
    st.textContent = '✓ Cantidad actualizada'; st.style.color = 'var(--green)';
  } catch(e) {
    st.textContent = '✗ ' + e.message; st.style.color = 'var(--red)';
  }
}

async function botUpdateMinLimit(adNumber, minAmount) {
  var data = await botCallWorker('/update-limit', { advNo: adNumber, minSingleTransAmount: parseFloat(minAmount) });
  if (data.code && data.code !== '000000') {
    var msg = data.message || (String(data.code) === '-1002'
      ? 'API key no autorizada: la cuenta no es comerciante P2P o la key no tiene permiso para editar anuncios'
      : '?');
    botLog('Límite [' + data.code + ']: ' + msg, '#E24B4A');
    throw new Error(msg);
  }
  return true;
}

async function botUpdatePrice(adNumber, price) {
  var data = await botCallWorker('/update-ad', { advNo: adNumber, price: parseFloat(price.toFixed(3)) });
  if (data.code && data.code !== '000000') {
    botLog('Binance [' + data.code + ']: ' + (data.message || '?'), '#E24B4A');
    throw new Error(data.message || 'Error Binance código ' + data.code);
  }
  return true;
}

function botLog(msg, color) {
  var el = document.getElementById('bot-log');
  var ts = new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  var line = document.createElement('div');
  line.style.color = color || '#aaa';
  line.style.borderBottom = '1px solid #111';
  line.style.paddingBottom = '2px';
  line.style.marginBottom = '2px';
  line.textContent = ts + '  ' + msg;
  if (el.firstChild && el.firstChild.textContent === 'Sin actividad') el.innerHTML = '';
  el.insertBefore(line, el.firstChild);
  // Máximo 30 líneas
  while (el.children.length > 30) el.removeChild(el.lastChild);
}

function botSetStatus(msg, color) {
  var el = document.getElementById('bot-status');
  el.textContent = msg; el.style.color = color || '#888';
}

async function botInitialCycle(allowPaused) {
  botLog('⚡ Posicionando...', '#F0B90B');
  try {
    var ad = await botGetMyAd(allowPaused);
    if (!ad) { botLog('⚠ Anuncio no encontrado para reprice inicial', '#F0B90B'); return; }
    BOT.adNumber     = ad.adNumber || ad.advNo;
    BOT.currentPrice = parseFloat(ad.price);
    BOT.myMinLimit   = parseFloat(ad.minSingleTransAmount);
    BOT.adPayTypes   = (ad.tradeMethods || []).map(function(m){ return m.identifier; })
                       .filter(function(id){ return id && GENERIC_PAY_IDS.indexOf(id) === -1; });
    if (BOT.adPayTypes.length) {
      botLog('💳 Métodos: ' + BOT.adPayTypes.map(payLabel).join(', '), '#8b949e');
      updateBotPayBadge();
      // Auto-sync selector del monitor con el primer método del anuncio que esté en PAY_METHODS
      var primary = null;
      for (var pi = 0; pi < BOT.adPayTypes.length; pi++) {
        if (PAY_METHODS.some(function(m){ return m.id === BOT.adPayTypes[pi]; })) {
          primary = BOT.adPayTypes[pi];
          break;
        }
      }
      // Auto-sync del selector solo en vista VES (el anuncio del bot es VES;
      // si estas revisando USD no hay que tocarte la vista).
      if (ACTIVE_FIAT === 'VES' && primary && primary !== ACTIVE_PAY) {
        ACTIVE_PAY = primary;
        PAY_SEL.VES = primary;
        resetLocalSeries();
        persistPaySel();
        var sel = document.getElementById('pay-method-select');
        if (sel) sel.value = primary;
        botLog('🔄 Selector ajustado → ' + payLabel(primary), '#8b949e');
      }
    }
    BOT.ceiling = BOT_CFG.sellPrice * (1 - (BOT_CFG.minSpread + (CFG.commission || 0)) / 100);
    document.getElementById('bot-ceiling').textContent    = BOT.ceiling.toFixed(3) + ' Bs';
    document.getElementById('bot-cur-price').textContent  = BOT.currentPrice.toFixed(3) + ' Bs';
    updateBotPriceColor();

    var market      = mapAds(await fetchTier(BOT.myMinLimit + BOT_CFG.limitThreshold, 2, BOT.adPayTypes));
    var myPays = BOT.adPayTypes && BOT.adPayTypes.length ? BOT.adPayTypes : [ACTIVE_PAY];
    var competitors = market.filter(function(a) {
      var aTypes = a.payTypes || [];
      var match = myPays.some(function(p) { return aTypes.indexOf(p) !== -1; });
      return String(a.advNo) !== String(BOT.adNumber) &&
             a.merchant !== (BOT_CFG.myNick || BOT.myNick) &&
             match &&
             a.minVES < (BOT.myMinLimit + BOT_CFG.limitThreshold) &&
             a.avail >= 150;
    });

    // above: competidores bajo el techo (sin límite de gap — reprice inicial)
    var above = competitors.filter(function(a) { return a.price > BOT.currentPrice && a.price <= BOT.ceiling; });
    var below = competitors.filter(function(a) { return a.price < BOT.currentPrice; });

    // Si el precio actual ya supera el techo, todos los competidores válidos están "abajo"
    // Recalcular above con referencia al techo si estamos sobre él
    if (BOT.currentPrice > BOT.ceiling) {
      above = competitors.filter(function(a) { return a.price <= BOT.ceiling; });
      below = [];
    }

    var targetPrice = null;
    if (above.length > 0) {
      above.sort(function(a, b) { return b.price - a.price; });
      targetPrice = above[0].price + BOT_CFG.increment;
    } else if (below.length > 0) {
      below.sort(function(a, b) { return b.price - a.price; });
      var proposed = below[0].price + BOT_CFG.increment;
      if (proposed < BOT.currentPrice) targetPrice = proposed;
    }

    if (targetPrice === null) { botLog('⚡ Inicial: posición óptima', '#1D9E75'); return; }
    if (targetPrice > BOT.ceiling) targetPrice = BOT.ceiling;
    if (Math.abs(targetPrice - BOT.currentPrice) < 0.001) { botLog('⚡ Inicial: sin cambio necesario', '#1D9E75'); return; }

    await botUpdatePrice(BOT.adNumber, targetPrice);
    var arrow = targetPrice > BOT.currentPrice ? '↑' : '↓';
    botLog('⚡ Inicial: ' + arrow + ' ' + BOT.currentPrice.toFixed(3) + ' → ' + targetPrice.toFixed(3) + ' Bs', '#F0B90B');
    BOT.currentPrice = targetPrice;
    document.getElementById('bot-cur-price').textContent = targetPrice.toFixed(3) + ' Bs';
    updateBotPriceColor();
    updateTopbarBotPrice(targetPrice);
  } catch(e) {
    botLog('⚠ Reprice inicial: ' + e.message, '#F6465D');
  }
}

function botServerConfig() {
  return {
    adNo: BOT_CFG.adNo,
    sellPrice: BOT_CFG.sellPrice,
    minSpread: BOT_CFG.minSpread,
    minLimit: BOT_CFG.minLimit,
    increment: BOT_CFG.increment,
    maxGap: BOT_CFG.maxGap,
    limitThreshold: BOT_CFG.limitThreshold,
    myNick: BOT_CFG.myNick || BOT.myNick || '',
    commission: CFG.commission || 0,
    verifiedOnly: CFG.verifiedOnly !== false,
    payTypes: (BOT.adPayTypes && BOT.adPayTypes.length) ? BOT.adPayTypes : [PAY_SEL.VES],
    tg: { token: TG.token, chatId: TG.chatId }
  };
}

async function botToggle() {
  if (BOT.running) {
    // ── STOP ────────────────────────────────────────────
    BOT.running = false;
    BOT.startSeq = (BOT.startSeq || 0) + 1; // cancela cualquier arranque aun en curso
    stopBotPoller();
    stopActivityWatcher();
    BOT.adPayTypes = [];
    updateBotPayBadge();
    updateManualBalance();

    document.getElementById('bot-toggle').textContent = '▶ Iniciar Bot';
    document.getElementById('bot-toggle').style.background = '';
    document.getElementById('bot-cur-price').textContent = '—';
    document.getElementById('bot-cur-price').style.color = 'var(--gold)';
    botUpdateCeiling();
    updateTopbarBotPrice(null);
    botSetStatus('Deteniendo...', '#888');
    botLog('— Bot detenido —', '#555');

    // Detener el bot en el servidor primero, luego pausar el anuncio
    try { await botCallWorker('/bot-disable'); } catch(e) {}
    if (BOT.adNumber) {
      try {
        var res = await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 3 });
        if (res.code && res.code !== '000000') throw new Error(res.message || 'código ' + res.code);
        if (res.failList && res.failList.length) throw new Error(res.failList[0].errorMsg || 'código ' + res.failList[0].errorCode);
        botLog('⏸ Anuncio pausado en Binance', '#8b949e');
      } catch(e) {
        botLog('⚠ No se pudo pausar el anuncio: ' + e.message, '#F6465D');
      }
    }
    botSetStatus('Detenido', '#555');
    if (TG.token && TG.chatId) sendTelegram('🔴 <b>Bot apagado</b>');

  } else {
    // ── START ────────────────────────────────────────────
    saveBotConfig();
    if (!SESSION.token)     { toast('Inicia sesión primero'); return; }
    if (!BOT_CFG.sellPrice) { toast('Ingresa el Precio de venta primero'); return; }

    // Marcar corriendo YA, para que un segundo toque dispare Detener durante el arranque.
    BOT.running = true;
    BOT.startSeq = (BOT.startSeq || 0) + 1;
    var startSeq = BOT.startSeq;

    document.getElementById('bot-toggle').textContent = '⏹ Detener Bot';
    document.getElementById('bot-toggle').style.background = '#E24B4A';
    document.getElementById('bot-live').style.display = 'grid';
    botLog('— Bot iniciado —', '#F0B90B');

    if (!BOT.adNumber && BOT_CFG.adNo) BOT.adNumber = BOT_CFG.adNo;

    // 1. Leer el anuncio (aún PAUSADO) para adNumber + métodos de pago
    if (!BOT.adNumber || !BOT.adPayTypes.length) {
      botSetStatus('Leyendo anuncio...', '#F0B90B');
      try {
        var adPre = await botGetMyAd(true);
        if (adPre) {
          BOT.adNumber   = adPre.adNumber || adPre.advNo;
          BOT.myMinLimit = parseFloat(adPre.minSingleTransAmount);
          BOT.adPayTypes = (adPre.tradeMethods || []).map(function(m){ return m.identifier; })
                            .filter(function(id){ return id && GENERIC_PAY_IDS.indexOf(id) === -1; });
          updateBotPayBadge();
        } else {
          botLog('⚠ Selecciona tu anuncio para activarlo/pausarlo', '#F0B90B');
        }
      } catch(e) {
        botLog('⚠ No se pudo leer el anuncio: ' + e.message, '#F6465D');
      }
    }

    // 1b. Aplicar métodos de pago elegidos (anuncio aún PAUSADO); salta si ya coinciden
    if ((BOT_CFG.payMethods || []).length && BOT.adNumber) {
      botSetStatus('Aplicando métodos...', '#F0B90B');
      try { await botApplyMethods(true, true); } catch(e) {}
    }

    // 2. Reprice inicial + límite mínimo mientras el anuncio está PAUSADO
    BOT.appliedMinLimit = 0;
    if (BOT_CFG.minLimit > 0 && BOT.adNumber) {
      botSetStatus('Aplicando límite mínimo...', '#F0B90B');
      try { await botUpdateMinLimit(BOT.adNumber, BOT_CFG.minLimit); BOT.appliedMinLimit = BOT_CFG.minLimit; } catch(e) {}
    }
    botSetStatus('Posicionando...', '#F0B90B');
    try { await botInitialCycle(true); } catch(e) {}

    // Si pulsaron Detener durante el arranque, abortar antes de activar/encender.
    if (BOT.startSeq !== startSeq) { botLog('— Inicio cancelado —', '#888'); return; }

    // 3. Activar el anuncio
    botSetStatus('Activando anuncio...', '#F0B90B');
    try {
      if (BOT.adNumber) {
        var res2 = await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 1 });
        if (res2.code && res2.code !== '000000') throw new Error(res2.message || 'código ' + res2.code);
        if (res2.failList && res2.failList.length) throw new Error(res2.failList[0].errorMsg || 'código ' + res2.failList[0].errorCode);
        botLog('▶ Anuncio activado', '#1D9E75');
      }
    } catch(e) {
      botLog('⚠ No se pudo activar el anuncio: ' + e.message, '#F6465D');
    }

    // Si cancelaron justo después de activar, pausar el anuncio y no encender el servidor.
    if (BOT.startSeq !== startSeq) {
      botLog('— Inicio cancelado — pausando anuncio', '#888');
      if (BOT.adNumber) { try { await botCallWorker('/toggle-ad', { advNo: BOT.adNumber, advStatus: 3 }); } catch(e) {} }
      return;
    }

    // 4. Encender el bot en el SERVIDOR (repricia 24/7 aunque cierres la página)
    try {
      await botCallWorker('/bot-enable', { config: botServerConfig() });
      botLog('☁ Bot corriendo en el servidor (~18s)', '#1D9E75');
    } catch(e) {
      botLog('⚠ No se pudo encender el bot en el servidor: ' + e.message, '#F6465D');
    }

    BOT.running = true;
    botSetStatus('✓ Bot activo', '#1D9E75');
    if (TG.token && TG.chatId) sendTelegram('🟢 <b>Bot encendido</b>');
    startBotPoller();
    startActivityWatcher();
    // Las notificaciones de ordenes nuevas las maneja el servidor (24/7, app cerrada).
  }
}

// ── Poller de estado del bot server-side ──────────────
var BOT_POLL = { timer: null, lastLogTs: 0 };
var BOT_LOG_COLORS = { up: '#1D9E75', down: '#5dade2', warn: '#F0B90B', error: '#E24B4A', info: '#8b949e' };

function startBotPoller() {
  stopBotPoller();
  pollBotState();
  // 15s: el reprice server-side es ~18s, pollear mas rapido solo gastaba invocaciones
  // Vercel sin ver nada nuevo (era el mayor consumidor con la app abierta).
  BOT_POLL.timer = setInterval(pollBotState, 15000);
}
function stopBotPoller() {
  if (BOT_POLL.timer) { clearInterval(BOT_POLL.timer); BOT_POLL.timer = null; }
}

async function pollBotState() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/bot-state');
    renderBotState(d);
  } catch(e) {}
}

function renderBotState(d) {
  if (!d) return;
  if (d.ad_number) BOT.adNumber = d.ad_number;
  if (d.status) botSetStatus(d.status, d.status.indexOf('Error') === 0 || d.status.indexOf('Detenido:') === 0 ? '#E24B4A' : '#1D9E75');
  if (d.current_price != null) {
    var p = parseFloat(d.current_price);
    BOT.currentPrice = p;
    document.getElementById('bot-cur-price').textContent = p.toFixed(3) + ' Bs';
    updateBotPriceColor();
    updateTopbarBotPrice(p);
  }
  // Pintar entradas nuevas del log del servidor
  if (Array.isArray(d.log)) {
    d.log.forEach(function(e){
      if (e && e.ts > BOT_POLL.lastLogTs) {
        botLog(e.msg, BOT_LOG_COLORS[e.level] || '#8b949e');
        // Solo errores a Telegram. Los reprices (up/down) son demasiado frecuentes (spam).
        if (TG.token && TG.chatId && e.level === 'error') sendTelegram('🤖 ' + e.msg);
      }
    });
    var maxTs = d.log.reduce(function(m, e){ return e && e.ts > m ? e.ts : m; }, BOT_POLL.lastLogTs);
    BOT_POLL.lastLogTs = maxTs;
  }
  // Si el servidor se auto-apagó (fondos bajos), reflejarlo en la UI
  if (d.enabled === false && BOT.running) {
    BOT.running = false;
    stopBotPoller();
    document.getElementById('bot-toggle').textContent = '▶ Iniciar Bot';
    document.getElementById('bot-toggle').style.background = '';
  }
  // Salud del bot: ultimo tick / reprice + watchdog de bot congelado. Si el
  // scheduler (DO/Vercel) muere, el anuncio queda publicado a precio viejo: avisar.
  var health = document.getElementById('bot-health');
  if (health) health.style.display = BOT.running ? 'flex' : 'none';
  if (BOT.running) {
    var nowH = Date.now();
    var tickMs = d.last_tick ? nowH - new Date(d.last_tick).getTime() : null;
    var repMs  = d.last_reprice ? nowH - new Date(d.last_reprice).getTime() : null;
    var bt = document.getElementById('bh-tick'), br = document.getElementById('bh-reprice');
    if (bt) { bt.textContent = 'Tick: ' + (tickMs != null ? 'hace ' + agoStr(tickMs) : '—'); bt.style.color = (tickMs != null && tickMs > 120000) ? 'var(--red)' : ''; }
    if (br) br.textContent = 'Reprice: ' + (repMs != null ? 'hace ' + agoStr(repMs) : '—');
    if (d.enabled !== false && tickMs != null && tickMs > 120000) {
      botSetStatus('⚠ Sin tick del servidor hace ' + agoStr(tickMs), '#E24B4A');
      if (nowH - (BOT.staleNotifTs || 0) > 10 * 60000) {
        BOT.staleNotifTs = nowH;
        botLog('⚠ Bot congelado: el servidor no repricia hace ' + agoStr(tickMs) + ' — revisa el scheduler', '#E24B4A');
        sendTelegram('⚠ <b>Bot congelado</b>: sin tick hace ' + agoStr(tickMs) + '. Tu anuncio puede estar a precio viejo.');
      }
    } else if (BOT.staleNotifTs && tickMs != null && tickMs < 60000) {
      BOT.staleNotifTs = 0;
      botLog('✓ Tick del servidor recuperado', '#1D9E75');
      sendTelegram('✓ Bot recuperado: el servidor volvió a repriciar.');
    }
  }
}

function agoStr(ms) {
  var s = Math.round(ms / 1000);
  if (s < 90) return s + 's';
  var m = Math.round(s / 60);
  if (m < 90) return m + ' min';
  return Math.round(m / 60) + ' h';
}

// Al cargar: si el bot quedó encendido en el servidor, reflejar estado + reanudar poller.
async function hydrateBotState() {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/bot-state');
    if (d && d.enabled) {
      BOT.running = true;
      document.getElementById('bot-toggle').textContent = '⏹ Detener Bot';
      document.getElementById('bot-toggle').style.background = '#E24B4A';
      document.getElementById('bot-live').style.display = 'grid';
      BOT_POLL.lastLogTs = Array.isArray(d.log) ? d.log.reduce(function(m,e){ return e&&e.ts>m?e.ts:m; }, 0) : 0;
      renderBotState(d);
      startBotPoller();
      startActivityWatcher();
      // Notificaciones de ordenes nuevas: server-side (24/7).
    }
  } catch(e) {}
}

// ── Telegram ──────────────────────────────────────────
var TG = { token: '', chatId: '' };

async function sendTelegram(msg) {
  if (!TG.token || !TG.chatId) return;
  try {
    var r = await fetch('https://api.telegram.org/bot' + TG.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG.chatId, text: msg, parse_mode: 'HTML' })
    });
    return r.ok;
  } catch(e) { return false; }
}

function loadTgConfig() {
  try {
    var s = localStorage.getItem('p2p_tg');
    if (!s) return;
    Object.assign(TG, JSON.parse(s));
    var tokenEl = document.getElementById('cfg-tg-token');
    var chatEl  = document.getElementById('cfg-tg-chat');
    if (tokenEl) tokenEl.value = TG.token;
    if (chatEl)  chatEl.value  = TG.chatId;
  } catch(e) {}
}

// ── Monitor 24/7 (server-side) ────────────────────────
var MON24 = { enabled: false, lastHb: 0, lastHist: 0, lastLogTs: 0 };

// Superficie de errores del monitor server-side: el peor fallo silencioso es
// "Telegram rechazo el envio" / "API fallo" — el server lo registra pero no puede
// avisarte por Telegram si Telegram es lo que falla. Lo mostramos en mon24-status.
// Reusa el poll de /monitor-state (sin requests extra). Primer poll: sembrar sin avisar.
function surfaceMonitorErrors(d) {
  if (!d || !Array.isArray(d.log)) return;
  var newest = 0, lastErr = null;
  d.log.forEach(function(e) {
    if (!e || !e.ts) return;
    if (e.ts > newest) newest = e.ts;
    if (e.ts > MON24.lastLogTs && (e.level === 'error' || e.level === 'warn')) lastErr = e;
  });
  if (MON24.lastLogTs === 0) { MON24.lastLogTs = newest; return; }
  var st = document.getElementById('mon24-status');
  if (lastErr && st) { st.textContent = '⚠ Monitor: ' + lastErr.msg; st.style.color = 'var(--red)'; }
  else if (st && st.style.color) { st.style.color = ''; renderMon24(d.status); } // se resolvio: volver a normal
  MON24.lastLogTs = Math.max(MON24.lastLogTs, newest);
}

// ── Sparkline 24h (mejor mayorista) ───────────────────
// Anuncios CREIBLES: con disponibilidad real (>=2000 USDT, mayorista real). Las listas
// vienen ordenadas desc por precio, asi que el primero que supera el umbral es el mejor.
// Evita que un listing fantasma se registre como pico en el grafico o dispare alertas.
var MIN_AVAIL = 2000;
// Escanea el MAX precio entre los creibles (independiente del orden de la lista,
// que puede venir en orden nativo de Binance si el filtro de monto esta en 0).
function credibleBest(a) {
  var best = null;
  for (var i = 0; i < (a || []).length; i++) {
    if (a[i].avail >= MIN_AVAIL && (!best || a[i].price > best.price)) best = a[i];
  }
  return best;
}
function credibleMay()   { return credibleBest(ST.mayoristas); }
function credibleSmall() { return credibleBest(ST.smallAds); }
function bestCredibleMay() { var m = credibleMay(); return m ? m.price : null; }
// Mediana del top-10 creible (misma criba que el server: avail >= MIN_AVAIL).
// Va en el heartbeat para que p2p_rate siga fresca con la app abierta.
function medianCredibleMay() {
  var prices = [];
  var a = ST.mayoristas || [];
  for (var i = 0; i < a.length; i++) if (a[i].avail >= MIN_AVAIL) prices.push(a[i].price);
  prices.sort(function(x, y) { return y - x; });
  prices = prices.slice(0, 10).sort(function(x, y) { return x - y; });
  if (!prices.length) return { rate: 0, n: 0 };
  var m = prices.length >> 1;
  return { rate: prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2, n: prices.length };
}

// HIST24 = series del servidor por metodo de pago { pay: [{ts,price}] }; se completa
// con los puntos vivos del cliente. Formato legado (array plano) = serie de BDV.
var HIST24 = {};
var LEGACY_PAY = 'BancoDeVenezuela';
function histByPay(h, pay) {
  if (Array.isArray(h)) return pay === LEGACY_PAY ? h : [];
  return (h && h[pay]) || [];
}
function sparkSeries() {
  var s = histByPay(HIST24, ACTIVE_PAY).slice();
  var lastTs = s.length ? s[s.length - 1].ts : 0;
  for (var i = 0; i < ST.priceHist.length; i++) {
    if (ST.priceHist[i].ts > lastTs) s.push(ST.priceHist[i]);
  }
  return s.filter(function(p) { return p && p.price; });
}
function renderSparkline() {
  var wrap = document.getElementById('spark-wrap');
  var svg  = document.getElementById('spark');
  if (!wrap || !svg) return;
  var pts = sparkSeries();
  if (pts.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  // viewBox 1:1 con el ancho real → sin distorsion (la barra es full-width).
  var H = 96, padX = 2, padT = 12, padB = 12;
  var W = Math.max(120, Math.round(svg.clientWidth || 600));
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var t0 = pts[0].ts, dt = (pts[pts.length - 1].ts - t0) || 1;
  var min = pts[0], max = pts[0];
  for (var i = 0; i < pts.length; i++) { if (pts[i].price < min.price) min = pts[i]; if (pts[i].price > max.price) max = pts[i]; }
  // Holgura vertical para que picos/valles no queden pegados al borde.
  var span = (max.price - min.price) || 1, lo = min.price - span * 0.1, hi = max.price + span * 0.1, dp = hi - lo;
  function X(ts) { return padX + (ts - t0) / dt * (W - 2 * padX); }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * (H - padT - padB); }
  var line = '';
  for (var j = 0; j < pts.length; j++) line += (j ? 'L' : 'M') + X(pts[j].ts).toFixed(1) + ' ' + Y(pts[j].price).toFixed(1) + ' ';
  var x0 = X(pts[0].ts), xL = X(pts[pts.length - 1].ts), yBase = H - padB;
  var area = 'M' + x0.toFixed(1) + ' ' + yBase + ' ' + line.substring(1) + 'L' + xL.toFixed(1) + ' ' + yBase + ' Z';
  var open = pts[0].price, close = pts[pts.length - 1].price, chg = (close - open) / open * 100;
  var up = close >= open, col = up ? '#2ebd85' : '#f6465d';
  svg.innerHTML =
    '<defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + col + '" stop-opacity="0.26"/>' +
      '<stop offset="100%" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
    '<line x1="' + padX + '" y1="' + Y(open).toFixed(1) + '" x2="' + (W - padX) + '" y2="' + Y(open).toFixed(1) +
      '" stroke="#3a3f4b" stroke-width="1" stroke-dasharray="3 4"/>' +
    '<path d="' + area + '" fill="url(#spg)"/>' +
    '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + X(max.ts).toFixed(1) + '" cy="' + Y(max.price).toFixed(1) + '" r="2.4" fill="#2ebd85"/>' +
    '<circle cx="' + X(min.ts).toFixed(1) + '" cy="' + Y(min.price).toFixed(1) + '" r="2.4" fill="#f6465d"/>' +
    '<circle cx="' + xL.toFixed(1) + '" cy="' + Y(close).toFixed(1) + '" r="3" fill="' + col + '"/>';
  document.getElementById('spark-range').innerHTML =
    '<span style="color:' + col + '">' + fmt(close) + fiatSuf() + ' (' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%)</span>' +
    ' <span style="color:var(--text-3);font-weight:400">· ' + fmt(min.price) + '–' + fmt(max.price) + '</span>';
}
window.addEventListener('resize', function() { try { renderSparkline(); } catch(e) {} try { if (HX.open) hxDraw(); } catch(e) {} });

// ── Historial completo (overlay pantalla completa) ──────────────
var HX = { open: false, series: [], ohlc: [], range: 'all', mode: 'candles' };
try { HX.mode = localStorage.getItem('p2p_hx_mode') || 'candles'; } catch(e) {}
var HX_RANGES = [
  { id: '24h', label: '24h',     ms: 24 * 3600e3 },
  { id: '7d',  label: '7 días',  ms: 7 * 24 * 3600e3 },
  { id: '30d', label: '30 días', ms: 30 * 24 * 3600e3 },
  { id: 'all', label: 'Todo',    ms: Infinity }
];
function openHistory() {
  HX.open = true;
  HX.hoverX = null;
  var hp = document.getElementById('hx-pay');
  if (hp) hp.textContent = ' · ' + payLabel(ACTIVE_PAY);
  document.getElementById('hx-overlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
  hxBindPointer();
  hxRenderRanges();
  hxLoad();
}
function closeHistory() {
  HX.open = false;
  document.getElementById('hx-overlay').style.display = 'none';
  document.body.style.overflow = '';
}
function hxMerge(histLong, hist24) {
  var byTs = {};
  [histLong, hist24].forEach(function(arr) {
    if (Array.isArray(arr)) arr.forEach(function(p) { if (p && p.price) byTs[p.ts] = p.price; });
  });
  return Object.keys(byTs).map(function(ts) { return { ts: +ts, price: byTs[ts] }; })
    .sort(function(a, b) { return a.ts - b.ts; });
}
function hxVisible() {
  var r = HX_RANGES.filter(function(x) { return x.id === HX.range; })[0];
  if (!r || r.ms === Infinity) return HX.series;
  var cut = Date.now() - r.ms;
  return HX.series.filter(function(p) { return p.ts >= cut; });
}
function hxMsg(t) {
  var m = document.getElementById('hx-msg'), c = document.getElementById('hx-chart');
  if (t) { m.textContent = t; m.style.display = ''; c.style.display = 'none'; }
  else { m.style.display = 'none'; c.style.display = ''; }
}
function hxTimeLabel(ts, spanMs) {
  var d = new Date(ts), p2 = function(n) { return (n < 10 ? '0' : '') + n; };
  if (spanMs <= 36 * 3600e3) return p2(d.getHours()) + ':' + p2(d.getMinutes());
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1);
}
function hxStats(pts) {
  var ids = ['hx-cur', 'hx-chg', 'hx-min', 'hx-max'];
  if (!pts.length) { ids.forEach(function(i) { document.getElementById(i).textContent = '—'; }); return; }
  var open = pts[0].price, close = pts[pts.length - 1].price, min = pts[0].price, max = pts[0].price;
  pts.forEach(function(p) { if (p.price < min) min = p.price; if (p.price > max) max = p.price; });
  var chg = open ? (close - open) / open * 100 : 0;
  document.getElementById('hx-cur').textContent = fmt(close) + fiatSuf();
  var chgEl = document.getElementById('hx-chg');
  chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
  chgEl.style.color = close >= open ? 'var(--green)' : 'var(--red)';
  document.getElementById('hx-min').textContent = fmt(min) + fiatSuf();
  document.getElementById('hx-max').textContent = fmt(max) + fiatSuf();
}
function hxBtnCss(active) {
  return 'border-radius:8px;padding:6px 13px;font-size:13px;cursor:pointer;font-weight:600;border:1px solid ' +
    (active ? 'var(--gold);background:var(--gold);color:#000' : 'var(--border);background:var(--surf-2);color:var(--text-3)');
}
function hxRenderRanges() {
  var wrap = document.getElementById('hx-ranges');
  wrap.innerHTML = '';
  HX_RANGES.forEach(function(r) {
    var b = document.createElement('button');
    b.textContent = r.label;
    b.style.cssText = hxBtnCss(r.id === HX.range);
    b.onclick = function() { HX.range = r.id; HX.hoverX = null; hxRenderRanges(); hxDraw(); };
    wrap.appendChild(b);
  });
  var sep = document.createElement('span');
  sep.style.cssText = 'flex:1';
  wrap.appendChild(sep);
  [['line', '📈 Línea'], ['candles', '🕯 Velas']].forEach(function(m) {
    var b = document.createElement('button');
    b.textContent = m[1];
    b.style.cssText = hxBtnCss(HX.mode === m[0]);
    b.onclick = function() {
      HX.mode = m[0];
      try { localStorage.setItem('p2p_hx_mode', m[0]); } catch(e) {}
      HX.hoverX = null; hxRenderRanges(); hxDraw();
    };
    wrap.appendChild(b);
  });
}
// Velas del rango, derivadas AL VUELO de la serie de puntos existente (hist24 +
// hist_long): asi funcionan desde el primer momento con todo el historial ya
// guardado, sin esperar a que hist_ohlc del servidor se llene hora a hora.
// Bucket adaptativo por rango para no dibujar cientos de velas apretadas.
function hxVisibleOhlc() {
  var pts = hxVisible();
  if (pts.length < 2) { HX.bucketMs = 3600000; return []; }
  var span = pts[pts.length - 1].ts - pts[0].ts;
  // Objetivo ~60-150 velas: elegir el bucket estandar mas cercano.
  var STEPS = [3600000, 2 * 3600000, 4 * 3600000, 6 * 3600000, 12 * 3600000, 24 * 3600000, 3 * 24 * 3600000, 7 * 24 * 3600000];
  var bMs = STEPS[0];
  for (var s = 0; s < STEPS.length; s++) { bMs = STEPS[s]; if (span / bMs <= 150) break; }
  HX.bucketMs = bMs;
  var buckets = {};
  for (var i = 0; i < pts.length; i++) {
    var t = Math.floor(pts[i].ts / bMs) * bMs, p = pts[i].price;
    var b = buckets[t];
    if (!b) buckets[t] = { t: t, o: p, h: p, l: p, c: p };
    else { b.c = p; if (p > b.h) b.h = p; if (p < b.l) b.l = p; }
  }
  return Object.keys(buckets).map(function(k) { return buckets[k]; }).sort(function(a, b) { return a.t - b.t; });
}
// Frame base en modo VELAS (grilla/ejes compartidos con el modo linea)
function hxDrawBaseCandles(cs, cssW, cssH, dpr) {
  var base = HX.base || (HX.base = document.createElement('canvas'));
  base.width = Math.round(cssW * dpr); base.height = Math.round(cssH * dpr);
  var ctx = base.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  var padL = 58, padR = 14, padT = 14, padB = 26, W = cssW - padL - padR, H = cssH - padT - padB;
  var bMs = HX.bucketMs || 3600000;
  var t0 = cs[0].t, t1 = cs[cs.length - 1].t + bMs, dt = (t1 - t0) || 1;
  var min = cs[0].l, max = cs[0].h;
  cs.forEach(function(k) { if (k.l < min) min = k.l; if (k.h > max) max = k.h; });
  var span = (max - min) || 1, lo = min - span * 0.08, hi = max + span * 0.08, dp = hi - lo;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }
  var up = cs[cs.length - 1].c >= cs[0].o;
  HX.px = { padL: padL, padT: padT, W: W, H: H, t0: t0, dt: dt, lo: lo, dp: dp, col: up ? '#2ebd85' : '#f6465d' };
  ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 5; i++) {
    var val = lo + (hi - lo) * i / 5, y = Y(val);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'right'; ctx.fillText(fmt(val), padL - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var ticks = Math.min(6, cs.length);
  for (var k2 = 0; k2 <= ticks; k2++) {
    var ts = t0 + dt * k2 / ticks;
    ctx.fillStyle = '#8b93a7';
    ctx.fillText(hxTimeLabel(ts, dt), Math.max(padL + 14, Math.min(padL + W - 14, X(ts))), padT + H + 7);
  }
  var cw = Math.max(2, Math.min(14, (W / cs.length) * 0.65));
  for (var q = 0; q < cs.length; q++) {
    var c = cs[q], cx = X(c.t + bMs / 2), colq = c.c >= c.o ? '#2ebd85' : '#f6465d';
    ctx.strokeStyle = colq; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, Y(c.h)); ctx.lineTo(cx, Y(c.l)); ctx.stroke();
    var yTop = Y(Math.max(c.o, c.c)), yBot = Y(Math.min(c.o, c.c));
    ctx.fillStyle = colq;
    ctx.fillRect(cx - cw / 2, yTop, cw, Math.max(1, yBot - yTop));
  }
}
// Dibuja el frame base (grilla, ejes, area, linea) en un canvas offscreen. Se
// regenera solo cuando cambia la data/rango/tamano; el mousemove solo lo blitea.
function hxDrawBase(pts, cssW, cssH, dpr) {
  var base = HX.base || (HX.base = document.createElement('canvas'));
  base.width = Math.round(cssW * dpr); base.height = Math.round(cssH * dpr);
  var ctx = base.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  var padL = 58, padR = 14, padT = 14, padB = 26, W = cssW - padL - padR, H = cssH - padT - padB;
  var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts, dt = (t1 - t0) || 1;
  var min = pts[0].price, max = pts[0].price;
  pts.forEach(function(p) { if (p.price < min) min = p.price; if (p.price > max) max = p.price; });
  var span = (max - min) || 1, lo = min - span * 0.08, hi = max + span * 0.08, dp = hi - lo;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }
  var open = pts[0].price, close = pts[pts.length - 1].price, col = close >= open ? '#2ebd85' : '#f6465d';
  HX.px = { padL: padL, padT: padT, W: W, H: H, t0: t0, dt: dt, lo: lo, dp: dp, col: col }; // para el crosshair
  ctx.font = '11px -apple-system, sans-serif'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 5; i++) {
    var val = lo + (hi - lo) * i / 5, y = Y(val);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillStyle = '#8b93a7'; ctx.textAlign = 'right'; ctx.fillText(fmt(val), padL - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var ticks = Math.min(6, pts.length);
  for (var k = 0; k <= ticks; k++) {
    var ts = t0 + dt * k / ticks, x = X(ts);
    ctx.fillStyle = '#8b93a7';
    ctx.fillText(hxTimeLabel(ts, dt), Math.max(padL + 14, Math.min(padL + W - 14, x)), padT + H + 7);
  }
  var grad = ctx.createLinearGradient(0, padT, 0, padT + H);
  grad.addColorStop(0, col + '44'); grad.addColorStop(1, col + '00');
  ctx.beginPath(); ctx.moveTo(X(pts[0].ts), Y(pts[0].price));
  for (var a = 1; a < pts.length; a++) ctx.lineTo(X(pts[a].ts), Y(pts[a].price));
  ctx.lineTo(X(t1), padT + H); ctx.lineTo(X(t0), padT + H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(pts[0].ts), Y(pts[0].price));
  for (var b = 1; b < pts.length; b++) ctx.lineTo(X(pts[b].ts), Y(pts[b].price));
  ctx.strokeStyle = col; ctx.lineWidth = 1.7; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.beginPath(); ctx.arc(X(t1), Y(close), 3.2, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
}
function hxDraw() {
  var pts = hxVisible();
  hxStats(pts);
  var candles = HX.mode === 'candles';
  var cs = candles ? hxVisibleOhlc() : [];
  // En velas, si el rango no tiene al menos 2 velas caemos a linea automaticamente.
  if (candles && cs.length < 2) candles = false;
  if ((candles ? cs.length : pts.length) < 2) { hxMsg('Aún no hay suficientes datos para este rango. El historial se acumula con el tiempo.'); return; }
  hxMsg('');
  var canvas = document.getElementById('hx-chart');
  var dpr = window.devicePixelRatio || 1, cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  // Regenerar el base solo si cambio modo/data/rango/tamano (no en cada mousemove)
  var lastT = candles ? cs[cs.length - 1].t : pts[pts.length - 1].ts;
  var key = (candles ? 'c' : 'l') + '|' + ACTIVE_PAY + '|' + HX.range + '|' + (candles ? cs.length : pts.length) + '|' + lastT + '|' + cssW + 'x' + cssH + '|' + dpr;
  if (HX.baseKey !== key) {
    if (candles) hxDrawBaseCandles(cs, cssW, cssH, dpr); else hxDrawBase(pts, cssW, cssH, dpr);
    HX.baseKey = key;
  }
  var bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(HX.base, 0, 0, cssW, cssH);
  var padL = HX.px.padL, padT = HX.px.padT, W = HX.px.W, H = HX.px.H;
  var t0 = HX.px.t0, dt = HX.px.dt, lo = HX.px.lo, dp = HX.px.dp, col = HX.px.col;
  function X(ts) { return padL + (ts - t0) / dt * W; }
  function Y(p)  { return padT + (1 - (p - lo) / dp) * H; }

  // Crosshair estilo TradingView: las lineas siguen al CURSOR (libre); el marcador
  // y el tooltip enganchan al dato mas cercano (punto en linea, vela en velas).
  if (HX.hoverX != null) {
    var cx = HX.hoverX, cy = HX.hoverY;
    var hts = t0 + ((cx - padL) / W) * dt;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, cy); ctx.lineTo(padL + W, cy); ctx.stroke();
    ctx.setLineDash([]);
    var l1, l2, l3 = null;
    if (candles) {
      var bMs = HX.bucketMs || 3600000, bc = cs[0], bd = Infinity;
      for (var q = 0; q < cs.length; q++) { var dd = Math.abs((cs[q].t + bMs / 2) - hts); if (dd < bd) { bd = dd; bc = cs[q]; } }
      var kcol = bc.c >= bc.o ? '#2ebd85' : '#f6465d';
      var mx = X(bc.t + bMs / 2);
      ctx.beginPath(); ctx.arc(mx, Y(bc.c), 4, 0, 2 * Math.PI); ctx.fillStyle = kcol; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      l1 = 'A ' + fmt(bc.o) + '  C ' + fmt(bc.c);
      l2 = 'Máx ' + fmt(bc.h) + '  Mín ' + fmt(bc.l);
      l3 = hxFullLabel(bc.t);
      col = kcol;
    } else {
      var bp = pts[0], bd2 = Infinity;
      for (var q2 = 0; q2 < pts.length; q2++) { var dd2 = Math.abs(pts[q2].ts - hts); if (dd2 < bd2) { bd2 = dd2; bp = pts[q2]; } }
      ctx.beginPath(); ctx.arc(X(bp.ts), Y(bp.price), 4, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      l1 = fmt(bp.price) + fiatSuf();
      l2 = hxFullLabel(bp.ts);
    }
    // Etiqueta de precio en el eje Y a la altura del cursor
    var curPrice = lo + (1 - (cy - padT) / H) * dp;
    ctx.font = '600 11px -apple-system, sans-serif';
    ctx.fillStyle = col; ctx.fillRect(0, cy - 9, padL - 4, 18);
    ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(curPrice), 4, cy);
    // Caja tooltip cerca del cursor
    ctx.font = '600 12px -apple-system, sans-serif';
    var lines = l3 != null ? [l1, l2, l3] : [l1, l2];
    var tw = 0; lines.forEach(function(s) { tw = Math.max(tw, ctx.measureText(s).width); }); tw += 16;
    var th = 14 * lines.length + 8, bx = cx + 12, by = cy - th - 12;
    if (bx + tw > padL + W) bx = cx - 12 - tw;
    if (by < padT) by = cy + 12;
    by = Math.max(padT, Math.min(padT + H - th, by));
    ctx.fillStyle = 'rgba(20,24,34,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 6); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(bx, by, tw, th); ctx.strokeRect(bx, by, tw, th); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = col; ctx.fillText(lines[0], bx + 8, by + 12);
    ctx.fillStyle = '#8b93a7'; ctx.font = '11px -apple-system, sans-serif';
    for (var li = 1; li < lines.length; li++) ctx.fillText(lines[li], bx + 8, by + 12 + 14 * li);
    ctx.restore();
  }
}
function hxFullLabel(ts) {
  var d = new Date(ts), p2 = function(n) { return (n < 10 ? '0' : '') + n; };
  return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
function hxPointer(e) {
  if (!HX.px) return;
  var cv = document.getElementById('hx-chart'), rect = cv.getBoundingClientRect();
  var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
  var px = t.clientX - rect.left, py = t.clientY - rect.top;
  HX.hoverX = Math.max(HX.px.padL, Math.min(HX.px.padL + HX.px.W, px));
  HX.hoverY = Math.max(HX.px.padT, Math.min(HX.px.padT + HX.px.H, py));
  hxDraw();
}
function hxBindPointer() {
  if (HX.bound) return;
  HX.bound = true;
  var cv = document.getElementById('hx-chart');
  cv.addEventListener('mousemove', hxPointer);
  cv.addEventListener('mouseleave', function() { HX.hoverX = null; hxDraw(); });
  cv.addEventListener('touchstart', function(e) { hxPointer(e); }, { passive: true });
  cv.addEventListener('touchmove', function(e) { hxPointer(e); }, { passive: true });
}
async function hxLoad() {
  if (!SESSION.token) { hxMsg('Inicia sesión primero.'); return; }
  hxMsg('Cargando historial...');
  try {
    var d = await botCallWorker('/monitor-history');
    HX.series = hxMerge(histByPay(d && d.hist_long, ACTIVE_PAY), histByPay(d && d.hist24, ACTIVE_PAY));
    var cov = document.getElementById('hx-coverage');
    if (cov) cov.textContent = HX.series.length
      ? '· ' + HX.series.length + ' puntos desde ' + hxFullLabel(HX.series[0].ts)
      : '';
    if (!HX.series.length) { hxMsg('Aún no hay datos. El historial se acumula con el tiempo.'); return; }
    hxDraw();
  } catch (e) { hxMsg('Error: ' + e.message); }
}
// Refresca la serie de 24h desde el servidor (max 1 vez cada 15 min, alineado con
// el latido para despertar Neon una sola vez por ciclo).
function refreshHist24() {
  if (!SESSION.token) return;
  var now = Date.now();
  if (now - MON24.lastHist < 15 * 60000) return;
  MON24.lastHist = now;
  botCallWorker('/monitor-state').then(function(d) {
    if (d && d.hist24) { HIST24 = d.hist24; renderSparkline(); }
    surfaceMonitorErrors(d);
  }).catch(function(){});
}

// Latido: avisa al servidor que la app esta abierta y refrescando, para que NO duplique
// la busqueda ni las alertas mientras tanto. Throttle ~30s.
function monitorHeartbeat() {
  // USD es solo vista local: sin latido, el servidor sigue vigilando VES 24/7
  // y los precios USD no contaminan las series del servidor.
  if (ACTIVE_FIAT !== 'VES') return;
  if (!MON24.enabled || !SESSION.token) return;
  var now = Date.now();
  // 15 min: cada latido despierta Neon ~5 min; a esta cadencia duerme ~2/3 del
  // tiempo con la app abierta. El servidor toma el relevo a los 35 min sin latido.
  if (now - MON24.lastHb < 15 * 60 * 1000) return;
  MON24.lastHb = now;
  // De paso, el precio que ve la app alimenta hist24 en el servidor (sparkline sin huecos de dia).
  var p = bestCredibleMay() || 0;
  var med = medianCredibleMay();
  botCallWorker('/monitor-heartbeat', { price: p, pay: ACTIVE_PAY, median: med.rate, medianN: med.n }).catch(function(){});
}

function monitorServerConfig() {
  return {
    refreshSec: 60, // servidor (app cerrada/oculta): 60s. La vista abierta sigue a CFG.interval (10s).
    quietStart: document.getElementById('cfg-mon-qstart').value || '',
    quietEnd:   document.getElementById('cfg-mon-qend').value   || '',
    quietRefreshSec: parseInt(document.getElementById('cfg-mon-qref').value) || 3600,
    summaryHour: document.getElementById('cfg-mon-summary').value || '',
    spreadThr: CFG.spreadThr,
    overboughtThr: CFG.overboughtThr,
    weaknessThr: CFG.weaknessThr,
    sustainThr: CFG.sustainThr,
    commission: CFG.commission || 0,
    mayAmount: CFG.mayAmount,
    smallAmount: CFG.smallAmount,
    verifiedOnly: CFG.verifiedOnly !== false,
    payTypes: [ACTIVE_PAY],
    tg: { token: TG.token, chatId: TG.chatId }
  };
}

// Encender/apagar el monitor server-side (lo dispara el boton Iniciar, no un boton aparte).
async function monitorServerEnable() {
  // El 24/7 del servidor es solo VES; en USD no tocar su config (vista local).
  if (ACTIVE_FIAT !== 'VES') { renderMon24('USD: solo vista local (24/7 sigue en VES)'); return; }
  if (!SESSION.token) { renderMon24(); return; }
  if (!TG.token || !TG.chatId) { MON24.enabled = false; renderMon24('Sin Telegram — solo vista local'); return; }
  try { await botCallWorker('/monitor-enable', { config: monitorServerConfig() }); MON24.enabled = true; MON24.lastHb = Date.now(); botCallWorker('/monitor-heartbeat').catch(function(){}); renderMon24('Corriendo en el servidor'); }
  catch(e) { MON24.enabled = false; renderMon24('Error 24/7: ' + e.message); }
}

async function monitorServerDisable() {
  try { await botCallWorker('/monitor-disable'); } catch(e) {}
  MON24.enabled = false; renderMon24();
}

function renderMon24(statusText) {
  var st = document.getElementById('mon24-status');
  if (st) st.textContent = MON24.enabled ? (statusText || 'Corriendo en el servidor') : (statusText || '');
}

async function hydrateMon24(isRetry) {
  if (!SESSION.token) return;
  try {
    var d = await botCallWorker('/monitor-state');
    MON24.enabled = !!(d && d.enabled);
    if (d && d.hist24) { HIST24 = d.hist24; MON24.lastHist = Date.now(); renderSparkline(); }
    renderMon24(d && d.status);
    surfaceMonitorErrors(d); // siembra lastLogTs sin avisar errores viejos
    // Si el monitor 24/7 quedo activo, arranca la vista (tablas a CFG.interval) sin pulsar Iniciar.
    if (MON24.enabled && !ST.running) startMonitorView();
  } catch(e) {
    // Fallo transitorio al abrir la app (cold start): si se traga el error, la UI
    // muestra el monitor "apagado" aunque siga corriendo en el servidor. Reintentar una vez.
    if (!isRetry) setTimeout(function(){ hydrateMon24(true); }, 5000);
  }
}

// ── Config ────────────────────────────────────────────
function saveConfig() {
  CFG.interval      = Math.max(10, parseInt(document.getElementById('cfg-int').value) || 30);
  CFG.spreadThr     = parseFloat(document.getElementById('cfg-spr').value) || 0.5;
  CFG.overboughtThr = parseFloat(document.getElementById('cfg-ob').value)  || 1.0;
  CFG.weaknessThr   = parseFloat(document.getElementById('cfg-wk').value)  || 0.5;
  CFG.sustainThr    = parseFloat(document.getElementById('cfg-sustain').value) || 1.5;
  var mayVal = document.getElementById('cfg-may-amount').value;
  CFG.mayAmount   = mayVal === '' ? 0 : (parseFloat(mayVal) || 0);
  CFG.smallAmount = parseFloat(document.getElementById('cfg-small-amount').value) || 59999;
  CFG.commission  = parseFloat(document.getElementById('cfg-commission').value)   || 0;
  CFG.buyAmount   = parseFloat(document.getElementById('cfg-buy-amount').value)   || 2000000;
  CFG.monQuietStart = document.getElementById('cfg-mon-qstart').value || '00:00';
  CFG.monQuietEnd   = document.getElementById('cfg-mon-qend').value   || '07:00';
  CFG.monQuietRef   = parseInt(document.getElementById('cfg-mon-qref').value) || 3600;
  CFG.monSummary    = document.getElementById('cfg-mon-summary').value || '08:00';
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  syncFilterInputs();
  if (ST.running) { clearInterval(ST.timer); ST.timer = setInterval(fetchOnce, CFG.interval * 1000); }
  updateCommissionLabels();
  botUpdateCeiling();
  fetchOnce();
  saveUserSettings();
  if (MON24.enabled && ACTIVE_FIAT === 'VES') { botCallWorker('/monitor-enable', { config: monitorServerConfig() }).catch(function(){}); }
  toast('Guardado');
}

function loadConfig() {
  try {
    var s = localStorage.getItem('p2p_cfg2');
    if (!s) return;
    Object.assign(CFG, JSON.parse(s));
    document.getElementById('cfg-int').value      = CFG.interval;
    document.getElementById('cfg-spr').value      = CFG.spreadThr;
    document.getElementById('cfg-ob').value       = CFG.overboughtThr;
    document.getElementById('cfg-wk').value       = CFG.weaknessThr;
    if (CFG.sustainThr != null) document.getElementById('cfg-sustain').value = CFG.sustainThr;
    document.getElementById('cfg-may-amount').value   = CFG.mayAmount;
    document.getElementById('cfg-small-amount').value = CFG.smallAmount;
    document.getElementById('cfg-commission').value   = CFG.commission;
    document.getElementById('cfg-buy-amount').value   = CFG.buyAmount;
    if (CFG.monQuietStart) document.getElementById('cfg-mon-qstart').value = CFG.monQuietStart;
    if (CFG.monQuietEnd)   document.getElementById('cfg-mon-qend').value   = CFG.monQuietEnd;
    if (CFG.monQuietRef)   document.getElementById('cfg-mon-qref').value   = CFG.monQuietRef;
    if (CFG.monSummary)    document.getElementById('cfg-mon-summary').value = CFG.monSummary;
  } catch(e) {}
  updateVerToggle();
}

function toggleVerified() {
  var on = CFG.verifiedOnly !== false;
  CFG.verifiedOnly = !on;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  updateVerToggle();
  fetchOnce();
  saveUserSettings();
}

function updateVerToggle() {
  var el = document.getElementById('ver-toggle');
  if (!el) return;
  var on = CFG.verifiedOnly !== false;
  el.classList.toggle('off', !on);
  el.title = on ? 'Solo verificados — clic para incluir a todos' : 'Mostrando todos — clic para solo verificados';
}

// Filtros inline (label en web) + tuerca (mobile): misma fuente CFG.
function setFilter(which, raw) {
  var map = { may: ['mayAmount', 2000000], small: ['smallAmount', 59999], buy: ['buyAmount', 2000000] };
  var m = map[which]; if (!m) return;
  // 0 o vacio = SIN filtro de monto (eleccion del usuario): la tabla muestra el
  // orden nativo de Binance, solo con filtros de verificados y metodo de pago.
  var v = (raw === '' || raw == null) ? 0 : parseFloat(raw);
  if (isNaN(v)) v = m[1];
  CFG[m[0]] = v;
  localStorage.setItem('p2p_cfg2', JSON.stringify(CFG));
  syncFilterInputs();
  fetchOnce();
  saveUserSettings();
}

function syncFilterInputs() {
  [['flt-may','cfg-may-amount','mayAmount'],
   ['flt-small','cfg-small-amount','smallAmount'],
   ['flt-buy','cfg-buy-amount','buyAmount']].forEach(function(p) {
    var a = document.getElementById(p[0]), b = document.getElementById(p[1]);
    if (a) a.value = CFG[p[2]];
    if (b) b.value = CFG[p[2]];
  });
}

// ── Utils ─────────────────────────────────────────────
function fmt(n) { return parseFloat(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtP(n) { return parseFloat(n).toLocaleString('es-VE', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
function fmtM(n) {
  n = parseFloat(n);
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return n.toFixed(0);
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg) {
  var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(function() { t.remove(); }, 2500);
}

// ── Sección Compra colapsable (oculta en mobile) ──────
function setBuyCollapsed(collapsed) {
  var body = document.getElementById('buy-section-body');
  var chev = document.getElementById('buy-chevron');
  if (body) body.style.display = collapsed ? 'none' : '';
  if (chev) chev.style.transform = collapsed ? 'rotate(-90deg)' : '';
  try { localStorage.setItem('p2p_buy_collapsed', collapsed ? '1' : '0'); } catch(e) {}
}
function toggleBuySection() {
  var body = document.getElementById('buy-section-body');
  var willCollapse = body && body.style.display !== 'none';
  setBuyCollapsed(willCollapse);
  // Al expandir, refrescar para traer la data BUY (no se pide mientras está colapsada).
  if (!willCollapse) fetchOnce();
}
function initBuySection() {
  var saved = null;
  try { saved = localStorage.getItem('p2p_buy_collapsed'); } catch(e) {}
  // Sin preferencia previa: colapsada en mobile, abierta en escritorio.
  setBuyCollapsed(saved === null ? window.innerWidth <= 760 : saved === '1');
}

loadConfig(); syncFilterInputs(); loadTgConfig(); loadBotConfig(); loadPayMethod(); loadActivityGuard(); updateCommissionLabels(); updNotifSt(); renderAlerts(); refreshAuthUI(); refreshPushState();
initBuySection();
// Enlaces de email (verify/reset) tienen prioridad; si no, valida sesion normal.
handleAuthLinks().then(function(handled){ if (!handled) initAuth(); });
renderOB('ob-may',   [], 'best');
renderOB('ob-small', [], 'best-buy');
renderBuySection([]);
renderBuySpread();
