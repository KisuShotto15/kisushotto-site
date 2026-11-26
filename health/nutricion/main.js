import { loadLocal, saveLocal, pull, push } from './sync.js';
import { calcBMR, calcTDEE, calcTarget, mealMacros, totalMacros, scalePortions,
         MICROS_DEF, calcRDA, totalMicros, totalFatTypes } from './calculator.js';
import { searchFoods, getFoodDetail, getApiKey, setApiKey } from './search.js';
import { FALLBACK_FOODS } from './data/fallback.js';

// ── Default meals (initial state) ─────────────────────────────────────────────
window.customConfirm = function(msg) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirm-msg');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    
    msgEl.textContent = msg;
    modal.classList.remove('hidden');
    
    function cleanup() {
      modal.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    }
    
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
};

const DEFAULT_MEALS = [
  { id:'m1', name:'Desayuno',  time:'07:00', ingredients:[
    { id:'i1a', name:'Huevos enteros',          fdcId:748967, amountG:200, per100g:{ calories:148, protein:12.6, fat:9.9,  carbs:0.7 } },
    { id:'i1b', name:'Aguacate',               fdcId:171706, amountG:80,  per100g:{ calories:160, protein:2.0,  fat:14.7, carbs:8.5 } },
    { id:'i1c', name:'Queso blanco duro',      fdcId:null,   amountG:40,  per100g:{ calories:370, protein:25.0, fat:30.0, carbs:2.0 } },
    { id:'i1d', name:'Aceite de coco',         fdcId:172336, amountG:5,   per100g:{ calories:862, protein:0,    fat:99.1, carbs:0   } },
  ]},
  { id:'m2', name:'Almuerzo',  time:'13:00', ingredients:[
    { id:'i2a', name:'Muslo de pollo con piel',fdcId:172869, amountG:400, per100g:{ calories:218, protein:18.8, fat:14.7, carbs:0   } },
    { id:'i2b', name:'Brócoli',               fdcId:170379, amountG:150, per100g:{ calories:34,  protein:2.8,  fat:0.4,  carbs:6.6 } },
    { id:'i2c', name:'Sofrito (cebolla/ajo/tomate)',fdcId:null,amountG:100,per100g:{ calories:35,  protein:1.0,  fat:0.1,  carbs:8.0 } },
    { id:'i2d', name:'Aceite de oliva',        fdcId:171413, amountG:12,  per100g:{ calories:884, protein:0,    fat:100,  carbs:0   } },
  ]},
  { id:'m3', name:'Merienda',  time:'16:30', ingredients:[
    { id:'i3a', name:'Sardinas en agua (lata)',fdcId:175139, amountG:125, per100g:{ calories:142, protein:24.6, fat:4.9,  carbs:0   } },
    { id:'i3b', name:'Queso blanco duro',      fdcId:null,   amountG:50,  per100g:{ calories:370, protein:25.0, fat:30.0, carbs:2.0 } },
  ]},
  { id:'m4', name:'Cena',      time:'20:00', ingredients:[
    { id:'i4a', name:'Huevos enteros',         fdcId:748967, amountG:150, per100g:{ calories:148, protein:12.6, fat:9.9,  carbs:0.7 } },
    { id:'i4b', name:'Espinaca',               fdcId:168462, amountG:100, per100g:{ calories:23,  protein:2.9,  fat:0.4,  carbs:3.6 } },
    { id:'i4c', name:'Mantequilla',            fdcId:173430, amountG:3,   per100g:{ calories:717, protein:0.9,  fat:81.1, carbs:0.1 } },
  ]},
];

function defaultProfile(name) {
  return {
    name,
    tdee: { weight:'', height:'', age:'', gender:'male', activity:1.55, goal:'maintenance', goalPct:15 },
    days: [{ id:'d1', label:'Día base', meals: JSON.parse(JSON.stringify(DEFAULT_MEALS)) }],
    activeDay: 'd1'
  };
}

// ── State ─────────────────────────────────────────────────────────────────────
let S = {
  activeProfile: 'ef',
  profiles: { ef: defaultProfile('Yo') },
  lastModified: 0,
  microCache: {},
};

let syncTimer = null;
let searchTargetMealId = null;
let pendingFood = null;
let pendingDetailFetch = null;
const _microFetchedSession = new Set(); // prevent re-fetching same fdcId twice per session
const _microFailedAt = new Map();       // fdcId -> timestamp del ultimo fallo, para reintentar

// ── State helpers ─────────────────────────────────────────────────────────────
function profile() { return S.profiles[S.activeProfile]; }
function day() {
  const p = profile();
  return p.days.find(d => d.id === p.activeDay) || p.days[0] || { meals: [] };
}
function uid()  { return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
function fmt(n) { return Math.round(n); }
function fmtD(n){ return n.toFixed(1); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// Migrate old state (profile.meals → profile.days)
function migrateState(s) {
  if (!s?.profiles) return s;
  Object.values(s.profiles).forEach(p => {
    if (Array.isArray(p.meals) && !p.days) {
      p.days = [{ id: 'd1', label: 'Día base', meals: p.meals }];
      p.activeDay = 'd1';
      delete p.meals;
    }
    if (!p.days) {
      p.days = [{ id: 'd1', label: 'Día base', meals: [] }];
      p.activeDay = 'd1';
    }
  });
  if (!s.microCache) s.microCache = {};
  if (!s.microCacheVersion || s.microCacheVersion < 3) {
    s.microCache = {};
    s.microCacheVersion = 3;
  }
  return s;
}

function save() {
  S.lastModified = Date.now();
  saveLocal(S);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; push(S); }, 1500);
}

// Push pendiente no puede quedar en el timer si el usuario cierra o cambia de pestana
function flushPush() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; push(S); }
}
window.addEventListener('pagehide', flushPush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPush();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const local = loadLocal();
  if (local) S = migrateState(local);

  render();
  hydrateForm();

  const localBefore = S.lastModified || 0;
  const cloud = await pull();
  // No pisar ediciones hechas mientras resolvia el pull
  if (cloud && (cloud.lastModified || 0) > (S.lastModified || 0) && (S.lastModified || 0) === localBefore) {
    S = migrateState(cloud);
    saveLocal(S);
    render();
    hydrateForm();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  renderProfiles();
  renderSummary();
  renderMeals();
  renderTDEEResults();
}

// ── Compras de la semana ─────────────────────────────────────────────────────
// Lista = gramos de cada ingrediente de los dias del plan × veces por semana.
// Precio por kg (lo pones una vez); el costo, el presupuesto y que da mas
// calorias por tu dinero salen de ahi. Lo tachado vale solo para esa semana.
const normName = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
function weekKey() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lunes
  return d.toISOString().slice(0, 10);
}
function shop() {
  const p = profile();
  p.shop = p.shop || {};
  const sh = p.shop;
  sh.currency = sh.currency || '$';
  sh.prices = sh.prices || {};
  if (!sh.freq) sh.freq = { [p.activeDay || p.days[0]?.id]: 7 };
  if (sh.checked?.week !== weekKey()) sh.checked = { week: weekKey(), keys: [] };
  return sh;
}
function shopItems() {
  const p = profile(), sh = shop(), map = {};
  for (const d of p.days || []) {
    const times = sh.freq[d.id] || 0;
    if (!times) continue;
    for (const m of d.meals || []) for (const ing of m.ingredients || []) {
      if (ing.disabled || !ing.amountG) continue;
      const key = normName(ing.name);
      const it = map[key] || (map[key] = { key, name: ing.name, g: 0, kcal100: ing.per100g?.calories || 0 });
      it.g += ing.amountG * times;
    }
  }
  return Object.values(map).sort((a, b) => b.g - a.g);
}
const grams = g => g >= 1000 ? (Math.round(g / 100) / 10).toLocaleString('es') + ' kg' : Math.round(g) + ' g';
// Lo que se compra por unidad: huevo mediano ~55 g, carton de 30. El precio se pone
// por carton, la lista dice cuantos huevos (y cartones) son y se agregan por unidad.
const UNITS = [{ re: /huevo|\begg/i, g: 55, one: 'huevo', many: 'huevos', pack: 30, packOne: 'cartón', packMany: 'cartones' }];
const unitOf = name => UNITS.find(u => u.re.test(name || '')) || null;
const qtyTxt = it => {
  const u = unitOf(it.name); if (!u) return grams(it.g);
  const n = Math.ceil(it.g / u.g - 0.05), packs = n / u.pack;
  return `${n} ${n === 1 ? u.one : u.many} · ${(Math.round(packs * 10) / 10).toLocaleString('es')} ${packs === 1 ? u.packOne : u.packMany}`;
};
// Precio guardado: por carton (unidades) o por kg; costo y precio por kg salen de ahi
const perKg = it => { const u = unitOf(it.name), p = shop().prices[it.key]; return u ? p / (u.pack * u.g / 1000) : p; };
const costOf = it => it.g / 1000 * perKg(it);
const money = (sh, v) => sh.currency + ' ' + (v >= 100 ? Math.round(v).toLocaleString('es') : (Math.round(v * 100) / 100).toLocaleString('es'));
function renderShop() {
  const el = document.getElementById('shopItems');
  if (!el) return;
  const p = profile(), sh = shop(), items = shopItems();
  const days = (p.days || []).reduce((a, d) => a + (sh.freq[d.id] || 0), 0);
  document.getElementById('shopFreq').innerHTML = '<span class="sf-l">Días del plan esta semana</span>' + (p.days || []).map(d =>
    `<span class="sf"><span>${esc(d.label || 'Día')}</span><button onclick="window._shopFreq('${d.id}',-1)" aria-label="Menos">−</button><b>${sh.freq[d.id] || 0}</b><button onclick="window._shopFreq('${d.id}',1)" aria-label="Más">+</button></span>`).join('');
  const checked = new Set(sh.checked.keys);
  el.innerHTML = items.length ? items.map(it => {
    const price = sh.prices[it.key];
    return `<li class="si${checked.has(it.key) ? ' on' : ''}">
      <button class="si-ck" onclick="window._shopCheck('${esc(it.key)}')" aria-label="Tachar"></button>
      <span class="si-n">${esc(it.name)} <small>${qtyTxt(it)}</small></span>
      <span class="si-p"><input type="number" inputmode="decimal" min="0" step="any" value="${price ?? ''}" placeholder="${unitOf(it.name) ? 'precio/' + unitOf(it.name).packOne : 'precio/kg'}"
        onchange="window._shopPrice('${esc(it.key)}',this.value)"><small>${price ? money(sh, costOf(it)) : ''}</small></span></li>`;
  }).join('') : '<li class="si-empty">Elige cuántos días de la semana comes cada día del plan.</li>';
  // costo, presupuesto y lo mas barato por caloria
  const priced = items.filter(it => sh.prices[it.key] > 0);
  const cost = priced.reduce((a, it) => a + costOf(it), 0);
  const kcal = items.reduce((a, it) => a + it.g / 100 * it.kcal100, 0);
  const pct = sh.budget ? Math.round(cost / sh.budget * 100) : null;
  const cheap = priced.filter(it => it.kcal100 > 0).map(it => ({ ...it, kpm: it.kcal100 * 10 / perKg(it) }))
    .sort((a, b) => b.kpm - a.kpm).slice(0, 3);
  document.getElementById('shopNote').textContent = `${items.length} alimentos · ${checked.size ? checked.size + ' tachados' : 'toca para tachar'}`;
  document.getElementById('shopCost').innerHTML = `
    <div class="sc-row"><div><div class="sc-l">Costo de la semana</div>
      <div class="sc-v">${priced.length ? money(sh, cost) : '—'}</div></div>
      <label class="sc-cur">Moneda <input value="${esc(sh.currency)}" maxlength="4" onchange="window._shopSet('currency',this.value)"></label></div>
    ${pct !== null ? `<div class="sc-bar${pct > 100 ? ' over' : ''}"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}
    <div class="sc-sub">${priced.length < items.length ? (items.length - priced.length === 1 ? 'Falta 1 precio · ' : `Faltan ${items.length - priced.length} precios · `) : ''}${pct !== null ? `${pct}% de tu presupuesto` : 'Sin presupuesto'}
      ${cost && kcal ? ` · ${money(sh, cost / kcal * 1000)} por cada 1000 kcal` : ''}</div>
    <label class="sc-bud">Presupuesto semanal <input type="number" inputmode="decimal" min="0" step="any" value="${sh.budget ?? ''}" placeholder="—"
      onchange="window._shopSet('budget',this.value)"></label>
    ${cheap.length ? `<div class="sc-cheap">Más calorías por tu dinero: <b>${cheap.map(c => esc(c.name)).join(', ')}</b>.</div>` : ''}
    ${days ? '' : '<div class="sc-sub">Sin días elegidos: la lista está vacía.</div>'}`;
}
window._shopFreq = (id, d) => { const sh = shop(); sh.freq[id] = Math.max(0, Math.min(14, (sh.freq[id] || 0) + d)); save(); renderShop(); };
window._shopCheck = key => { const sh = shop(), k = sh.checked.keys, i = k.indexOf(key); if (i >= 0) k.splice(i, 1); else k.push(key); save(); renderShop(); };
window._shopPrice = (key, v) => { const sh = shop(), n = parseFloat(String(v).replace(',', '.')); if (n > 0) sh.prices[key] = n; else delete sh.prices[key]; save(); renderShop(); };
window._shopSet = (k, v) => {
  const sh = shop();
  if (k === 'currency') sh.currency = String(v).trim().slice(0, 4) || '$';
  else { const n = parseFloat(String(v).replace(',', '.')); sh.budget = n > 0 ? n : null; }
  save(); renderShop();
};

// ── Profiles ──────────────────────────────────────────────────────────────────
function renderProfiles() {
  const bar = document.getElementById('profilesBar');
  const ids = Object.keys(S.profiles);
  bar.innerHTML = ids.map(id => {
    const active = id === S.activeProfile ? ' active' : '';
    const delBtn = ids.length > 1
      ? `<span class="pill-del" onclick="event.stopPropagation(); window._deleteProfile('${id}')" title="Eliminar">×</span>`
      : '';
    return `<div class="profile-pill${active}">
      <span class="pill-name" onclick="window._switchProfile('${id}')"
            ondblclick="event.stopPropagation(); window._renameProfile('${id}',this)">${esc(S.profiles[id].name)}</span>
      <span class="pill-rename" onclick="event.stopPropagation(); window._renameProfile('${id}',this.previousElementSibling)" title="Renombrar">✎</span>
      ${delBtn}
    </div>`;
  }).join('') + `<button class="profile-pill profile-pill--add" onclick="window._addProfile()">+ Perfil</button>`;
}

window._renameProfile = function(id, nameEl) {
  if (nameEl.querySelector('input')) return;
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = current;
  input.style.width = Math.max(60, current.length * 9) + 'px';
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const val = input.value.trim() || current;
    S.profiles[id].name = val;
    save();
    nameEl.textContent = val;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { nameEl.textContent = current; }
  });
};

window._switchProfile = function(id) {
  S.activeProfile = id;
  save();
  render();
  hydrateForm();
};

window._addProfile = function() {
  const name = prompt('Nombre del perfil:');
  if (!name?.trim()) return;
  const id = name.trim().toLowerCase().replace(/\s+/g,'-') + '-' + uid().slice(0,4);
  S.profiles[id] = defaultProfile(name.trim());
  S.activeProfile = id;
  save();
  render();
  hydrateForm();
};

window._deleteProfile = async function(id) {
  const ids = Object.keys(S.profiles);
  if (ids.length <= 1) { alert('No puedes eliminar el único perfil.'); return; }
  if (!(await window.customConfirm(`¿Eliminar el perfil "${S.profiles[id].name}"?`))) return;
  delete S.profiles[id];
  if (S.activeProfile === id) S.activeProfile = Object.keys(S.profiles)[0];
  save();
  render();
  hydrateForm();
};

// ── Days ──────────────────────────────────────────────────────────────────────
function renderDayTabs() {
  const bar = document.getElementById('daysBar');
  if (!bar) return;
  const p = profile();
  const tabs = p.days.map(d => {
    const active = d.id === p.activeDay ? ' active' : '';
    const delBtn = p.days.length > 1
      ? `<span class="day-tab-del" onclick="event.stopPropagation(); window._deleteDay('${d.id}')" title="Eliminar día">×</span>`
      : '';
    return `<div class="day-tab${active}" onclick="window._switchDay('${d.id}')">
      <span class="day-tab-label" ondblclick="event.stopPropagation(); window._editDayLabel('${d.id}',this)">${esc(d.label)}</span>
      ${delBtn}
    </div>`;
  }).join('');
  bar.innerHTML = tabs + `<button class="day-tab day-tab--add" onclick="window._addDay()">+ día</button>`;
}

window._switchDay = function(id) {
  profile().activeDay = id;
  save();
  renderDayTabs();
  renderSummary();
  renderMeals();
};

window._addDay = function() {
  const label = prompt('Nombre del día (ej: Entreno, Descanso, Refeed):');
  if (!label?.trim()) return;
  const p = profile();
  const id = uid();
  p.days.push({ id, label: label.trim(), meals: [] });
  p.activeDay = id;
  save();
  renderDayTabs();
  renderSummary();
  renderMeals();
};

window._deleteDay = async function(id) {
  const p = profile();
  if (p.days.length <= 1) { alert('No puedes eliminar el único día.'); return; }
  if (!(await window.customConfirm(`¿Eliminar "${p.days.find(d => d.id === id)?.label}"?`))) return;
  p.days = p.days.filter(d => d.id !== id);
  if (p.activeDay === id) p.activeDay = p.days[0].id;
  save();
  renderDayTabs();
  renderSummary();
  renderMeals();
};

window._editDayLabel = function(id, el) {
  if (el.querySelector('input')) return;
  const current = el.textContent;
  const input = document.createElement('input');
  input.className = 'inline-edit day-label-edit';
  input.value = current;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const val = input.value.trim() || current;
    const d = profile().days.find(d => d.id === id);
    if (d) { d.label = val; save(); }
    el.textContent = val;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { el.textContent = current; }
  });
};

// ── TDEE panel ────────────────────────────────────────────────────────────────
window._toggleTDEE = function() {
  const body    = document.getElementById('tdeeBody');
  const chevron = document.getElementById('tdeeChevron');
  const open    = body.style.display !== 'none';
  body.style.display    = open ? 'none' : 'block';
  chevron.classList.toggle('open', !open);
};

function hydrateForm() {
  const t = profile().tdee;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('tdeeWeight',  t.weight);
  set('tdeeHeight',  t.height);
  set('tdeeAge',     t.age);
  set('tdeeGender',  t.gender);
  set('tdeeActivity',t.activity);
  set('tdeeGoal',    t.goal);
  set('tdeeGoalPct', t.goalPct);
  toggleGoalPct();
  renderTDEEResults();
}

window._updateTDEE = function() {
  const t = profile().tdee;
  t.weight  = parseFloat(document.getElementById('tdeeWeight')?.value)  || '';
  t.height  = parseFloat(document.getElementById('tdeeHeight')?.value)  || '';
  t.age     = parseInt(document.getElementById('tdeeAge')?.value)        || '';
  t.gender  = document.getElementById('tdeeGender')?.value  || 'male';
  t.activity= parseFloat(document.getElementById('tdeeActivity')?.value) || 1.55;
  t.goal    = document.getElementById('tdeeGoal')?.value    || 'maintenance';
  t.goalPct = parseInt(document.getElementById('tdeeGoalPct')?.value)    || 15;
  toggleGoalPct();
  renderTDEEResults();
  save();
};

function toggleGoalPct() {
  const field = document.getElementById('goalPctField');
  if (!field) return;
  const goal = document.getElementById('tdeeGoal')?.value || 'maintenance';
  field.style.display = goal === 'maintenance' ? 'none' : '';
}

function renderTDEEResults() {
  const el = document.getElementById('tdeeResults');
  if (!el) return;
  const t = profile().tdee;
  if (!t.weight || !t.height || !t.age) {
    el.innerHTML = '<span class="tdee-hint">Ingresa peso, altura y edad para ver tu TDEE.</span>';
    return;
  }
  const bmr    = calcBMR(t.weight, t.height, t.age, t.gender);
  const tdee   = calcTDEE(bmr, t.activity);
  const target = calcTarget(tdee, t.goal, t.goalPct);
  const label  = t.goal === 'deficit' ? 'Déficit' : t.goal === 'surplus' ? 'Volumen' : 'Mantenimiento';
  const h2  = (t.height / 100) ** 2;
  const bmi = t.weight / h2;
  let bmiCat, bmiStatus, bmiAdjust;
  if (bmi < 18.5)      { bmiCat = 'Bajo peso';  bmiStatus = 'low';  bmiAdjust = `Te faltan ${(18.5 * h2 - t.weight).toFixed(1)} kg para el rango normal`; }
  else if (bmi < 25)   { bmiCat = 'Normal';     bmiStatus = 'ok';   bmiAdjust = `Margen: ${(t.weight - 18.5 * h2).toFixed(1)} kg sobre el minimo · ${(24.9 * h2 - t.weight).toFixed(1)} kg bajo el maximo`; }
  else if (bmi < 30)   { bmiCat = 'Sobrepeso';  bmiStatus = 'high'; bmiAdjust = `Te sobran ${(t.weight - 24.9 * h2).toFixed(1)} kg para el rango normal`; }
  else                 { bmiCat = 'Obesidad';   bmiStatus = 'high'; bmiAdjust = `Te sobran ${(t.weight - 24.9 * h2).toFixed(1)} kg para el rango normal`; }
  const bmiPos = Math.min(100, Math.max(0, (bmi - 14) / (36 - 14) * 100));
  el.innerHTML = `
    <div class="tdee-chips">
      <div class="tdee-chip">
        <div class="tdee-chip-val">${bmr}</div>
        <div class="tdee-chip-label">Basal</div>
      </div>
      <div class="tdee-chip">
        <div class="tdee-chip-val">${tdee}</div>
        <div class="tdee-chip-label">Gasto diario</div>
      </div>
      <div class="tdee-chip tdee-chip--accent">
        <div class="tdee-chip-val">${target}</div>
        <div class="tdee-chip-label">Meta · ${label}</div>
      </div>
    </div>
    <div class="bmi-block" data-bmi="${bmiStatus}">
      <div class="bmi-head">
        <span class="bmi-label">IMC</span>
        <span class="bmi-val">${bmi.toFixed(1)}</span>
        <span class="bmi-cat">${bmiCat}</span>
      </div>
      <div class="bmi-scale">
        <div class="bmi-seg bmi-seg--low"></div>
        <div class="bmi-seg bmi-seg--ok"></div>
        <div class="bmi-seg bmi-seg--over"></div>
        <div class="bmi-seg bmi-seg--obese"></div>
        <div class="bmi-marker" style="left:${bmiPos}%"></div>
      </div>
      <div class="bmi-adjust">${bmiAdjust}</div>
    </div>
    <button class="btn-accent" onclick="window._applyTDEE(${target})">Aplicar al plan ↗</button>`;
}

window._applyTDEE = function(target) {
  if (!totalMacros(day().meals).calories) {
    alert('No hay ingredientes activos que escalar. Agrega comidas primero.');
    return;
  }
  day().meals = scalePortions(day().meals, target);
  save();
  renderSummary();
  renderMeals();
};

// ── Micronutrient coverage ────────────────────────────────────────────────────
async function ensureMicros(ingredients) {
  const apiKey = getApiKey(S.activeProfile);
  if (!apiKey) return;
  // Detect entries populated from search results (no actual micro data)
  const isStale = c => {
    if (!c || Object.keys(c).length === 0) return true;
    // epa+dha both 0 means search result, not detail endpoint (search returns null for fatty acids)
    return !c.epa && !c.dha;
  };
  const needsFetch = i => {
    if (!i.fdcId) return false;
    if (_microFetchedSession.has(i.fdcId)) return false; // fetched OK this session
    const failedAt = _microFailedAt.get(i.fdcId);
    if (failedAt && Date.now() - failedAt < 30000) return false; // backoff tras fallo de red
    if (!(i.fdcId in S.microCache)) return true;
    return isStale(S.microCache[i.fdcId]);
  };
  const unique = [...new Set(ingredients.filter(needsFetch).map(i => i.fdcId))];
  if (!unique.length) return;
  let anyOk = false;
  for (let i = 0; i < unique.length; i += 4) {
    await Promise.allSettled(
      unique.slice(i, i + 4).map(async fdcId => {
        try {
          S.microCache[fdcId] = await getFoodDetail(fdcId, apiKey);
          _microFetchedSession.add(fdcId);
          _microFailedAt.delete(fdcId);
          anyOk = true;
        } catch {
          _microFailedAt.set(fdcId, Date.now());
        }
      })
    );
  }
  if (anyOk) save();
}

let _microsRun = 0;
async function renderMicros() {
  const el = document.getElementById('micros-list');
  if (!el) return;
  const apiKey = getApiKey(S.activeProfile);
  if (!apiKey) {
    el.innerHTML = `<div class="micros-loading">Para ver vitaminas y minerales, activa la búsqueda USDA (gratis).
      <button class="link-btn" onclick="window._openApiKeyModal()">Configurar</button></div>`;
    renderFatTypes(day().meals);
    return;
  }
  if (!el.querySelector('.micro-row')) {
    el.innerHTML = '<div class="micros-loading">Calculando cobertura...</div>';
  }
  const run = ++_microsRun;
  const meals = day().meals;
  const allIngs = meals.flatMap(m => m.ingredients);
  await ensureMicros(allIngs);
  if (run !== _microsRun) return; // otra ejecucion mas nueva ya va a pintar
  const t      = profile().tdee;
  const age    = parseInt(t.age) || 30;
  const gender = t.gender || 'male';
  const rda    = calcRDA(age, gender);
  const totals = totalMicros(meals, S.microCache);

  el.innerHTML = MICROS_DEF.map(def => {
    const total  = totals[def.key] || 0;
    const rdaVal = rda[def.key] || 1;
    const pct    = Math.round(total / rdaVal * 100);
    const barPct = Math.min(100, pct);
    const isExc  = def.ul != null && total >= def.ul;
    const status = isExc ? 'exc' : pct < 70 ? 'warn' : pct > 120 ? 'sup' : 'ok';
    const label  = status === 'ok' ? 'Cubierto' : status === 'warn' ? 'Bajo' : status === 'exc' ? 'Exceso' : 'Óptimo';
    const sources = [];
    for (const meal of meals) {
      for (const ing of meal.ingredients) {
        if (!ing.fdcId) continue;
        const cached = S.microCache[ing.fdcId];
        if (!cached) continue;
        const f = ing.amountG / 100;
        const amt = def.key === 'omega3'
          ? ((cached.epa || 0) + (cached.dha || 0)) * f
          : (cached[def.key] || 0) * f;
        if (amt / rdaVal * 100 >= 5) sources.push({ name: ing.name, amt });
      }
    }
    sources.sort((a, b) => b.amt - a.amt);
    const srcText = sources.length ? sources.slice(0, 3).map(s => esc(s.name)).join(' · ') : '—';
    const fmtA = v => v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
    return `<div class="micro-row" data-status="${status}" data-pct="${pct}">
      <div class="micro-name">${def.label}</div>
      <div class="micro-source">${srcText}</div>
      <div class="micro-bar"><div class="micro-bar-fill" style="--pct:${barPct}%"></div><div class="micro-bar-mark"></div></div>
      <div class="micro-amt">${fmtA(total)}${def.unit}<span>/${fmtA(rdaVal)}${def.unit}</span></div>
      <div class="micro-pct">${pct}<span>%</span></div>
      <div class="micro-status">${label}</div>
    </div>`;
  }).join('');

  renderFatTypes(meals);
}

function renderFatTypes(meals) {
  const el = document.getElementById('fat-dist');
  if (!el) return;
  const { sat, mono, poly } = totalFatTypes(meals, S.microCache);
  const known = sat + mono + poly;
  if (known === 0) {
    el.innerHTML = '';
    document.getElementById('fatSection').hidden = true;
    return;
  }
  document.getElementById('fatSection').hidden = false;
  const pSat  = Math.round(sat  / known * 100);
  const pMono = Math.round(mono / known * 100);
  const pPoly = 100 - pSat - pMono;
  const fmt1  = v => v.toFixed(1);
  el.innerHTML = `
    <div class="fat-dist-bar">
      <div class="fat-dist-seg fds-sat"  style="width:${pSat}%"  title="Saturadas ${pSat}%"></div>
      <div class="fat-dist-seg fds-mono" style="width:${pMono}%" title="Monoinsaturadas ${pMono}%"></div>
      <div class="fat-dist-seg fds-poly" style="width:${pPoly}%" title="Poliinsaturadas ${pPoly}%"></div>
    </div>
    <div class="fat-dist-legend">
      <div class="fat-dist-item">
        <span class="fdi-dot fds-sat"></span>
        <span class="fdi-label">Saturadas</span>
        <span class="fdi-val">${fmt1(sat)}g · ${pSat}%</span>
      </div>
      <div class="fat-dist-item">
        <span class="fdi-dot fds-mono"></span>
        <span class="fdi-label">Monoinsaturadas</span>
        <span class="fdi-val">${fmt1(mono)}g · ${pMono}%</span>
      </div>
      <div class="fat-dist-item">
        <span class="fdi-dot fds-poly"></span>
        <span class="fdi-label">Poliinsaturadas</span>
        <span class="fdi-val">${fmt1(poly)}g · ${pPoly}%</span>
      </div>
    </div>`;
}

// ── Summary bar ───────────────────────────────────────────────────────────────
function renderSummary() {
  const el = document.getElementById('summaryBar');
  if (!el) return;
  const m = totalMacros(day().meals);
  const t = profile().tdee;
  let targetKcal = 0;
  if (t.weight && t.height && t.age) {
    const bmr  = calcBMR(t.weight, t.height, t.age, t.gender);
    const tdee = calcTDEE(bmr, t.activity);
    targetKcal = calcTarget(tdee, t.goal, t.goalPct);
  }
  const pct = targetKcal ? Math.min(100, Math.round(m.calories / targetKcal * 100)) : null;
  el.innerHTML = `
    <div class="macro-block cal">
      <div class="macro-val">${fmt(m.calories)}</div>
      <div class="macro-unit">KCAL / DÍA</div>
      ${pct !== null ? `<div class="macro-progress"><div class="macro-progress-bar" style="width:${pct}%"></div></div><div class="macro-label">${pct}% de tu meta (${fmt(targetKcal)})</div>` : '<div class="macro-label">Total</div>'}
    </div>
    <div class="macro-block prot">
      <div class="macro-val">${fmt(m.protein)}<span class="macro-val-unit">g</span></div>
      <div class="macro-unit">PROTEÍNA</div>
      <div class="macro-label">${m.calories ? fmt(m.protein * 4 / m.calories * 100) : 0}% kcal</div>
    </div>
    <div class="macro-block fat">
      <div class="macro-val">${fmt(m.fat)}<span class="macro-val-unit">g</span></div>
      <div class="macro-unit">GRASAS</div>
      <div class="macro-label">${m.calories ? fmt(m.fat * 9 / m.calories * 100) : 0}% kcal</div>
    </div>
    <div class="macro-block carb">
      <div class="macro-val">${fmt(m.carbs)}<span class="macro-val-unit">g</span></div>
      <div class="macro-unit">CARBOS</div>
      <div class="macro-label">${m.calories ? fmt(m.carbs * 4 / m.calories * 100) : 0}% kcal</div>
    </div>`;
  // Cuanto falta (o sobra) para la meta, con ideas baratas para completar
  const gap = document.getElementById('kcalGap');
  const diff = targetKcal ? Math.round((targetKcal - m.calories) / 50) * 50 : 0;
  if (gap) {
    gap.hidden = Math.abs(diff) < 150;
    gap.className = 'kcal-gap' + (diff < 0 ? ' over' : '');
    gap.innerHTML = diff > 0 ? `Te faltan <b>~${diff} kcal</b> para tu meta. ${cheapFill(diff)}`
      : `Te pasas <b>~${-diff} kcal</b> de tu meta.`;
  }
  renderShop();
  renderMicros();
}
const FILLERS = [['2 cdas de aceite', 240], ['50 g de maní', 290], ['1 taza de avena con leche', 300], ['1 plátano', 120], ['2 huevos', 150], ['1 taza de arroz', 200]];
function cheapFill(kcal) {
  const pick = []; let left = kcal;
  for (const [n, k] of FILLERS) { if (left <= 60) break; if (k <= left + 80) { pick.push(n); left -= k; } }
  return pick.length ? 'Por ejemplo: ' + pick.join(' + ') + '.' : '';
}

// ── Meals ─────────────────────────────────────────────────────────────────────
function renderMeals() {
  renderDayTabs();
  const container = document.getElementById('mealsContainer');
  if (!container) return;
  const meals = day().meals;
  if (!meals.length) {
    container.innerHTML = '<div class="meals-empty">Sin comidas. Agrega una.</div>';
    return;
  }
  container.innerHTML = meals.map((meal, idx) => renderMealCard(meal, idx, meals.length)).join('');
}

function renderMealCard(meal, idx, total) {
  const m = mealMacros(meal.ingredients);
  return `
  <div class="meal-card" id="mc-${meal.id}">
    <div class="meal-header" onclick="window._toggleMeal('${meal.id}')">
      <div class="meal-left">
        <div class="meal-number">${String(idx+1).padStart(2,'0')}</div>
        <div class="meal-info">
          <h3 class="editable" onclick="event.stopPropagation(); window._editField('${meal.id}','name',this)">${esc(meal.name || 'Comida ' + (idx + 1))}</h3>
          <div class="meal-time editable" onclick="event.stopPropagation(); window._editField('${meal.id}','time',this)">${esc(meal.time)}</div>
        </div>
      </div>
      <div class="meal-macros">
        <div class="meal-macro-item"><div class="meal-macro-val p">${fmt(m.protein)}g</div><div class="meal-macro-label">Prot</div></div>
        <div class="meal-macro-item"><div class="meal-macro-val f">${fmt(m.fat)}g</div><div class="meal-macro-label">Grasa</div></div>
        <div class="meal-macro-item"><div class="meal-macro-val c">${fmt(m.carbs)}g</div><div class="meal-macro-label">Carbo</div></div>
        <div class="meal-macro-item"><div class="meal-macro-val k">${fmt(m.calories)}</div><div class="meal-macro-label">kcal</div></div>
      </div>
      <div class="meal-controls" onclick="event.stopPropagation()">
        ${idx > 0       ? `<button class="icon-btn" onclick="window._moveMeal('${meal.id}',-1)" title="Subir">↑</button>` : '<span class="icon-btn-placeholder"></span>'}
        ${idx < total-1 ? `<button class="icon-btn" onclick="window._moveMeal('${meal.id}',1)"  title="Bajar">↓</button>` : '<span class="icon-btn-placeholder"></span>'}
        <button class="icon-btn icon-btn--danger" onclick="window._deleteMeal('${meal.id}')" title="Eliminar">⌫</button>
      </div>
      <div class="chevron" id="chev-${meal.id}">▼</div>
    </div>
    <div class="meal-body" id="body-${meal.id}">
      <ul class="ingredient-list">
        ${meal.ingredients.map(ing => renderIngredient(ing, meal.id)).join('')}
      </ul>
      <button class="add-ing-btn" onclick="window._openSearch('${meal.id}')">+ Agregar ingrediente</button>
    </div>
  </div>`;
}

function renderIngredient(ing, mealId) {
  const m = mealMacros([{ ...ing, amountG: ing.amountG }]);
  const disabled = !!ing.disabled;
  const toggleIcon = disabled
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>`;
  return `
  <li class="ingredient-item${disabled ? ' ing--disabled' : ''}" id="ii-${ing.id}">
    <span class="ing-name">${esc(ing.name)}${unitOf(ing.name) ? `<small class="ing-cnt">≈ ${(Math.round(ing.amountG / unitOf(ing.name).g * 10) / 10).toLocaleString("es")} ${unitOf(ing.name).many}</small>` : ''}</span>
    <div class="ing-amount-wrap">
      <input class="ing-amount" type="number" value="${ing.amountG}" min="1" step="any"
        onchange="window._updateAmount('${mealId}','${ing.id}',this.value)"
        onclick="event.stopPropagation()">
      <span class="ing-unit">g</span>
    </div>
    <span class="ing-macros">${disabled ? '—' : `${fmt(m.protein)}P · ${fmt(m.fat)}F · ${fmt(m.carbs)}C · ${fmt(m.calories)}kcal`}</span>
    <button class="ing-toggle" onclick="window._toggleIngredient('${mealId}','${ing.id}'); event.stopPropagation()" title="${disabled ? 'Activar' : 'Desactivar'}">${toggleIcon}</button>
    <button class="ing-del" onclick="window._deleteIng('${mealId}','${ing.id}'); event.stopPropagation()" title="Eliminar">×</button>
  </li>`;
}

// ── Meal CRUD ─────────────────────────────────────────────────────────────────
window._toggleMeal = function(id) {
  const body   = document.getElementById(`body-${id}`);
  const chevron= document.getElementById(`chev-${id}`);
  const open   = body.classList.contains('open');
  document.querySelectorAll('.meal-body').forEach(b => b.classList.remove('open'));
  document.querySelectorAll('.chevron[id^="chev-"]').forEach(c => c.classList.remove('open'));
  if (!open) { body.classList.add('open'); chevron?.classList.add('open'); }
};

window._deleteMeal = async function(id) {
  if (!(await window.customConfirm('¿Eliminar esta comida?'))) return;
  day().meals = day().meals.filter(m => m.id !== id);
  save(); renderSummary(); renderMeals();
};

window._moveMeal = function(id, dir) {
  const meals = day().meals;
  const idx   = meals.findIndex(m => m.id === id);
  const nIdx  = idx + dir;
  if (nIdx < 0 || nIdx >= meals.length) return;
  [meals[idx], meals[nIdx]] = [meals[nIdx], meals[idx]];
  save(); renderMeals();
};

window._addMeal = function() {
  day().meals.push({ id: uid(), name: 'Nueva comida', time: '00:00', ingredients: [] });
  save(); renderMeals();
  const lastId = day().meals.at(-1).id;
  setTimeout(() => window._toggleMeal(lastId), 50);
};

// ── Inline edit meal name / time ──────────────────────────────────────────────
window._editField = function(mealId, field, el) {
  if (el.querySelector('input')) return;
  const current = el.textContent;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = current;
  if (field === 'time') input.type = 'time';
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const val = input.value.trim() || current;
    const meal = day().meals.find(m => m.id === mealId);
    if (meal) { meal[field] = val; save(); }
    el.textContent = val;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { el.textContent = current; } });
};

// ── Ingredient CRUD ───────────────────────────────────────────────────────────
window._deleteIng = function(mealId, ingId) {
  const meal = day().meals.find(m => m.id === mealId);
  if (!meal) return;
  meal.ingredients = meal.ingredients.filter(i => i.id !== ingId);
  save(); renderSummary(); renderMeals();
  setTimeout(() => {
    const body = document.getElementById(`body-${mealId}`);
    const chev = document.getElementById(`chev-${mealId}`);
    if (body) { body.classList.add('open'); }
    if (chev) { chev.classList.add('open'); }
  }, 30);
};

window._toggleIngredient = function(mealId, ingId) {
  const meal = day().meals.find(m => m.id === mealId);
  if (!meal) return;
  const ing = meal.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  ing.disabled = !ing.disabled;
  save(); renderSummary();
  // Update in-place to avoid closing the meal card
  const li = document.getElementById(`ii-${ingId}`);
  if (li) {
    const m = mealMacros([{ ...ing, amountG: ing.amountG }]);
    const disabled = !!ing.disabled;
    li.classList.toggle('ing--disabled', disabled);
    const nameEl = li.querySelector('.ing-name');
    if (nameEl) nameEl.style.textDecoration = disabled ? 'line-through' : '';
    const macroEl = li.querySelector('.ing-macros');
    if (macroEl) macroEl.textContent = disabled ? '—' : `${fmt(m.protein)}P · ${fmt(m.fat)}F · ${fmt(m.carbs)}C · ${fmt(m.calories)}kcal`;
    const toggleBtn = li.querySelector('.ing-toggle');
    if (toggleBtn) {
      toggleBtn.title = disabled ? 'Activar' : 'Desactivar';
      toggleBtn.innerHTML = disabled
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>`;
    }
  }
};

window._updateAmount = function(mealId, ingId, val) {
  const meal = day().meals.find(m => m.id === mealId);
  if (!meal) return;
  const ing = meal.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  ing.amountG = Math.max(1, parseFloat(val) || 1);
  save(); renderSummary();
  const m = mealMacros([ing]);
  const li = document.getElementById(`ii-${ingId}`);
  if (li) {
    const macroEl = li.querySelector('.ing-macros');
    if (macroEl) macroEl.textContent = `${fmt(m.protein)}P · ${fmt(m.fat)}F · ${fmt(m.carbs)}C · ${fmt(m.calories)}kcal`;
    const cnt = li.querySelector('.ing-cnt'), u = unitOf(ing.name);
    if (cnt && u) cnt.textContent = `≈ ${(Math.round(ing.amountG / u.g * 10) / 10).toLocaleString("es")} ${u.many}`;
  }
  const mealMac = mealMacros(day().meals.find(m2 => m2.id === mealId)?.ingredients || []);
  const card = document.getElementById(`mc-${mealId}`);
  if (card) {
    const vals = card.querySelectorAll('.meal-macro-val');
    if (vals[0]) vals[0].textContent = `${fmt(mealMac.protein)}g`;
    if (vals[1]) vals[1].textContent = `${fmt(mealMac.fat)}g`;
    if (vals[2]) vals[2].textContent = `${fmt(mealMac.carbs)}g`;
    if (vals[3]) vals[3].textContent = `${fmt(mealMac.calories)}`;
  }
};

// ── Search modal ──────────────────────────────────────────────────────────────
let searchDebounce = null;

window._openSearch = function(mealId) {
  searchTargetMealId = mealId;
  pendingFood = null;
  const modal = document.getElementById('searchModal');
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  const amountWrap = document.getElementById('amountWrap');
  modal.classList.remove('hidden');
  input.value = '';
  results.innerHTML = '';
  amountWrap.classList.add('hidden');
  input.focus();
  renderFallbackResults('');
};

window._closeSearch = function() {
  document.getElementById('searchModal').classList.add('hidden');
  searchTargetMealId = null;
  pendingFood = null;
};

window._handleSearchInput = function() {
  clearTimeout(searchDebounce);
  const q = document.getElementById('searchInput').value.trim();
  searchDebounce = setTimeout(() => doSearch(q), 400);
};

async function doSearch(q) {
  const results = document.getElementById('searchResults');
  if (!q) { renderFallbackResults(''); return; }
  renderFallbackResults(q);
  const apiKey = getApiKey(S.activeProfile);
  if (!apiKey) return;
  results.innerHTML = '<div class="search-loading">Buscando...</div>';
  try {
    // primero la lista local (en español: "huevo" encuentra "Huevo entero"), luego USDA
    const local = FALLBACK_FOODS.filter(f => normName(f.name).includes(normName(q)));
    const foods = [...local, ...(await searchFoods(q, apiKey))];
    if (!foods.length) { renderFallbackResults(q); return; }
    searchResultsList = foods;
    results.innerHTML = foods.map((f, i) => renderFoodResult(f, i)).join('');
  } catch {
    renderFallbackResults(q);
  }
}

function renderFallbackResults(q) {
  const results = document.getElementById('searchResults');
  const filtered = q
    ? FALLBACK_FOODS.filter(f => normName(f.name).includes(normName(q)))
    : FALLBACK_FOODS;
  if (!filtered.length) { results.innerHTML = '<div class="search-loading">Sin resultados.</div>'; return; }
  searchResultsList = filtered;
  results.innerHTML = filtered.map((f, i) => renderFoodResult(f, i)).join('');
}

let searchResultsList = [];

function renderFoodResult(food, i) {
  const p100 = food.per100g;
  return `<div class="search-result" onclick="window._selectFood(${i})">
    <div class="sr-name">${esc(food.name)}</div>
    <div class="sr-macros">${fmtD(p100.protein)}P · ${fmtD(p100.fat)}F · ${fmtD(p100.carbs)}C · ${fmt(p100.calories)}kcal <span class="sr-per">/ 100g${unitOf(food.name) ? ` · se agrega por ${unitOf(food.name).one}` : ''}</span></div>
  </div>`;
}

window._selectFood = function(idx) {
  const food = searchResultsList[idx];
  if (!food) return;
  pendingFood = JSON.parse(JSON.stringify(food)); // clonar: no mutar FALLBACK_FOODS ni resultados
  document.getElementById('amountWrap').classList.remove('hidden');
  document.getElementById('selectedFoodName').textContent = pendingFood.name;
  // Huevos y demas por unidad: se escribe cuantos y se guarda en gramos
  setAmountMode(unitOf(pendingFood.name) ? 'unit' : 'g');
  document.getElementById('ingredientAmount').focus();
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchInput').value = '';
  pendingDetailFetch = null;
  // SR Legacy search responses often omit EPA/DHA — fetch detail to fill gaps
  if (pendingFood.fdcId && pendingFood.per100g && (pendingFood.per100g.epa === 0 && pendingFood.per100g.dha === 0)) {
    const key = getApiKey(S.activeProfile);
    if (key) {
      pendingDetailFetch = getFoodDetail(pendingFood.fdcId, key).then(detail => {
        if (detail) pendingFood.per100g = detail;
      }).catch(() => {});
    }
  }
};

let amountMode = 'g';
function setAmountMode(mode) {
  const u = unitOf(pendingFood?.name), el = document.getElementById('ingredientAmount');
  amountMode = u ? mode : 'g';
  el.value = amountMode === 'unit' ? '2' : '100';
  el.step = amountMode === 'unit' ? '1' : 'any';
  document.getElementById('amountUnit').textContent = amountMode === 'unit' ? u.many : 'g';
  const sw = document.getElementById('amountSwitch');
  sw.hidden = !u;
  if (u) sw.textContent = amountMode === 'unit' ? 'Usar gramos' : `Por ${u.one}`;
  amountHint();
}
function amountHint() {
  const u = unitOf(pendingFood?.name), n = parseFloat(document.getElementById('ingredientAmount').value) || 0;
  document.getElementById('amountHint').textContent = !u ? '' : amountMode === 'unit'
    ? `≈ ${Math.round(n * u.g)} g (huevo mediano ~${u.g} g)` : `≈ ${(Math.round(n / u.g * 10) / 10).toLocaleString("es")} ${u.many}`;
}
window._amountSwitch = () => setAmountMode(amountMode === 'unit' ? 'g' : 'unit');
window._amountHint = amountHint;
window._confirmIngredient = async function() {
  if (!pendingFood || !searchTargetMealId) return;
  if (pendingDetailFetch) await pendingDetailFetch;
  const amtEl = document.getElementById('ingredientAmount');
  const v = parseFloat(amtEl.value) || 0, u = unitOf(pendingFood.name);
  const amountG = amountMode === 'unit' && u ? Math.max(1, Math.round((v || 1) * u.g)) : Math.max(1, v || 100);
  const meal = day().meals.find(m => m.id === searchTargetMealId);
  if (!meal) return;
  if (pendingFood.fdcId && pendingFood.per100g) {
    S.microCache[pendingFood.fdcId] = pendingFood.per100g;
  }
  const ing = {
    id:     uid(),
    name:   pendingFood.name,
    fdcId:  pendingFood.fdcId || null,
    amountG,
    per100g: {
      calories: pendingFood.per100g.calories,
      protein:  pendingFood.per100g.protein,
      fat:      pendingFood.per100g.fat,
      carbs:    pendingFood.per100g.carbs,
    }
  };
  meal.ingredients.push(ing);
  save();
  window._closeSearch();
  renderSummary();
  const openMeals = new Set(
    [...document.querySelectorAll('.meal-body.open')].map(el => el.id.replace('body-', ''))
  );
  openMeals.add(searchTargetMealId);
  renderMeals();
  openMeals.forEach(id => {
    document.getElementById(`body-${id}`)?.classList.add('open');
    document.getElementById(`chev-${id}`)?.classList.add('open');
  });
};

// ── API key modal ─────────────────────────────────────────────────────────────
window._openApiKeyModal = function() {
  const modal = document.getElementById('apiKeyModal');
  const input = document.getElementById('apiKeyInput');
  input.value = getApiKey(S.activeProfile);
  modal.classList.remove('hidden');
  input.focus();
};

window._closeApiKeyModal = function() {
  document.getElementById('apiKeyModal').classList.add('hidden');
};

window._saveApiKey = function() {
  const key = document.getElementById('apiKeyInput').value.trim();
  setApiKey(S.activeProfile, key);
  window._closeApiKeyModal();
};

// ── Close modals on backdrop click ────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.id === 'searchModal')  window._closeSearch();
  if (e.target.id === 'apiKeyModal')  window._closeApiKeyModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    window._closeSearch();
    window._closeApiKeyModal();
  }
  if (e.key === 'Enter' && !document.getElementById('amountWrap')?.classList.contains('hidden')) {
    window._confirmIngredient();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
