import { loadLocal, saveLocal, pull, push } from './sync.js';
import { calcBMR, calcTDEE, calcTarget, mealMacros, totalMacros, scalePortions } from './calculator.js';
import { searchFoods, getApiKey, setApiKey } from './search.js';
import { FALLBACK_FOODS } from './data/fallback.js';

// ── Default meals (initial state) ─────────────────────────────────────────────
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
    meals: JSON.parse(JSON.stringify(DEFAULT_MEALS))
  };
}

// ── State ─────────────────────────────────────────────────────────────────────
let S = {
  activeProfile: 'ef',
  profiles: { ef: defaultProfile('Yo') },
  lastModified: 0
};

let syncTimer = null;
let searchTargetMealId = null;
let pendingFood = null;

// ── State helpers ─────────────────────────────────────────────────────────────
function profile()  { return S.profiles[S.activeProfile]; }
function uid()      { return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }
function fmt(n)     { return Math.round(n); }
function fmtD(n)    { return n.toFixed(1); }

function save() {
  S.lastModified = Date.now();
  saveLocal(S);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => push(S), 1500);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const local = loadLocal();
  if (local) S = local;

  render();

  // Hydrate TDEE form
  hydrateForm();

  // Try cloud pull
  const cloud = await pull();
  if (cloud && (cloud.lastModified || 0) > (S.lastModified || 0)) {
    S = cloud;
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

// ── Profiles ──────────────────────────────────────────────────────────────────
function renderProfiles() {
  const bar = document.getElementById('profilesBar');
  const ids = Object.keys(S.profiles);
  bar.innerHTML = ids.map(id => {
    const active = id === S.activeProfile ? ' active' : '';
    return `<button class="profile-pill${active}" onclick="window._switchProfile('${id}')">${S.profiles[id].name}</button>`;
  }).join('') + `<button class="profile-pill profile-pill--add" onclick="window._addProfile()">+ Perfil</button>`;
}

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

window._deleteProfile = function(id) {
  const ids = Object.keys(S.profiles);
  if (ids.length <= 1) { alert('No puedes eliminar el único perfil.'); return; }
  if (!confirm(`¿Eliminar el perfil "${S.profiles[id].name}"?`)) return;
  delete S.profiles[id];
  if (S.activeProfile === id) S.activeProfile = Object.keys(S.profiles)[0];
  save();
  render();
  hydrateForm();
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
  el.innerHTML = `
    <div class="tdee-chips">
      <div class="tdee-chip">
        <div class="tdee-chip-val">${bmr}</div>
        <div class="tdee-chip-label">BMR</div>
      </div>
      <div class="tdee-chip">
        <div class="tdee-chip-val">${tdee}</div>
        <div class="tdee-chip-label">TDEE</div>
      </div>
      <div class="tdee-chip tdee-chip--accent">
        <div class="tdee-chip-val">${target}</div>
        <div class="tdee-chip-label">Target · ${label}</div>
      </div>
    </div>
    <button class="btn-accent" onclick="window._applyTDEE(${target})">Aplicar al plan ↗</button>`;
}

window._applyTDEE = function(target) {
  const p = profile();
  p.meals = scalePortions(p.meals, target);
  save();
  renderSummary();
  renderMeals();
};

// ── Summary bar ───────────────────────────────────────────────────────────────
function renderSummary() {
  const el = document.getElementById('summaryBar');
  if (!el) return;
  const m = totalMacros(profile().meals);
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
      ${pct !== null ? `<div class="macro-progress"><div class="macro-progress-bar" style="width:${pct}%"></div></div><div class="macro-label">${pct}% del target</div>` : '<div class="macro-label">Total</div>'}
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
      <div class="macro-unit">CARBS</div>
      <div class="macro-label">${m.calories ? fmt(m.carbs * 4 / m.calories * 100) : 0}% kcal</div>
    </div>`;
}

// ── Meals ─────────────────────────────────────────────────────────────────────
function renderMeals() {
  const container = document.getElementById('mealsContainer');
  if (!container) return;
  const meals = profile().meals;
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
          <h3 class="editable" onclick="event.stopPropagation(); window._editField('${meal.id}','name',this)">${meal.name}</h3>
          <div class="meal-time editable" onclick="event.stopPropagation(); window._editField('${meal.id}','time',this)">${meal.time}</div>
        </div>
      </div>
      <div class="meal-macros">
        <div class="meal-macro-item"><div class="meal-macro-val p">${fmt(m.protein)}g</div><div class="meal-macro-label">Prot</div></div>
        <div class="meal-macro-item"><div class="meal-macro-val f">${fmt(m.fat)}g</div><div class="meal-macro-label">Fat</div></div>
        <div class="meal-macro-item"><div class="meal-macro-val c">${fmt(m.carbs)}g</div><div class="meal-macro-label">Carb</div></div>
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
  return `
  <li class="ingredient-item" id="ii-${ing.id}">
    <span class="ing-name">${ing.name}</span>
    <div class="ing-amount-wrap">
      <input class="ing-amount" type="number" value="${ing.amountG}" min="1"
        onchange="window._updateAmount('${mealId}','${ing.id}',this.value)"
        onclick="event.stopPropagation()">
      <span class="ing-unit">g</span>
    </div>
    <span class="ing-macros">${fmt(m.protein)}P · ${fmt(m.fat)}F · ${fmt(m.carbs)}C · ${fmt(m.calories)}kcal</span>
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

window._deleteMeal = function(id) {
  if (!confirm('¿Eliminar esta comida?')) return;
  const p = profile();
  p.meals = p.meals.filter(m => m.id !== id);
  save(); renderSummary(); renderMeals();
};

window._moveMeal = function(id, dir) {
  const meals = profile().meals;
  const idx   = meals.findIndex(m => m.id === id);
  const nIdx  = idx + dir;
  if (nIdx < 0 || nIdx >= meals.length) return;
  [meals[idx], meals[nIdx]] = [meals[nIdx], meals[idx]];
  save(); renderMeals();
};

window._addMeal = function() {
  const p = profile();
  p.meals.push({ id: uid(), name: 'Nueva comida', time: '00:00', ingredients: [] });
  save(); renderMeals();
  // Open last meal
  const lastId = p.meals.at(-1).id;
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
    const meal = profile().meals.find(m => m.id === mealId);
    if (meal) { meal[field] = val; save(); }
    el.textContent = val;
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { el.textContent = current; } });
};

// ── Ingredient CRUD ───────────────────────────────────────────────────────────
window._deleteIng = function(mealId, ingId) {
  const meal = profile().meals.find(m => m.id === mealId);
  if (!meal) return;
  meal.ingredients = meal.ingredients.filter(i => i.id !== ingId);
  save(); renderSummary(); renderMeals();
  // Re-open that meal
  setTimeout(() => {
    const body = document.getElementById(`body-${mealId}`);
    const chev = document.getElementById(`chev-${mealId}`);
    if (body) { body.classList.add('open'); }
    if (chev) { chev.classList.add('open'); }
  }, 30);
};

window._updateAmount = function(mealId, ingId, val) {
  const meal = profile().meals.find(m => m.id === mealId);
  if (!meal) return;
  const ing = meal.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  ing.amountG = Math.max(1, parseInt(val) || 1);
  save(); renderSummary();
  // Update just the macros text for this ingredient without full re-render
  const m = mealMacros([ing]);
  const li = document.getElementById(`ii-${ingId}`);
  if (li) {
    const macroEl = li.querySelector('.ing-macros');
    if (macroEl) macroEl.textContent = `${fmt(m.protein)}P · ${fmt(m.fat)}F · ${fmt(m.carbs)}C · ${fmt(m.calories)}kcal`;
  }
  // Update meal header macros
  const mealMac = mealMacros(profile().meals.find(m2 => m2.id === mealId)?.ingredients || []);
  const card = document.getElementById(`mc-${mealId}`);
  if (card) {
    const vals = card.querySelectorAll('.meal-macro-val');
    if (vals[0]) vals[0].textContent = `${fmt(mealMac.protein)}g`;  // meal-macro-val uses IBM Plex Mono, fine
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

  // Show fallback immediately
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

  // Filter fallback first while waiting for USDA
  renderFallbackResults(q);

  const apiKey = getApiKey(S.activeProfile);
  if (!apiKey) return; // no key → only fallback

  results.innerHTML = '<div class="search-loading">Buscando...</div>';
  try {
    const foods = await searchFoods(q, apiKey);
    if (!foods.length) { renderFallbackResults(q); return; }
    results.innerHTML = foods.map(f => renderFoodResult(f)).join('');
  } catch {
    renderFallbackResults(q);
  }
}

function renderFallbackResults(q) {
  const results = document.getElementById('searchResults');
  const filtered = q
    ? FALLBACK_FOODS.filter(f => f.name.toLowerCase().includes(q.toLowerCase()))
    : FALLBACK_FOODS;
  if (!filtered.length) { results.innerHTML = '<div class="search-loading">Sin resultados.</div>'; return; }
  results.innerHTML = filtered.map(f => renderFoodResult(f)).join('');
}

function renderFoodResult(food) {
  const p100 = food.per100g;
  const data = encodeURIComponent(JSON.stringify(food));
  return `<div class="search-result" onclick="window._selectFood('${data}')">
    <div class="sr-name">${food.name}</div>
    <div class="sr-macros">${fmtD(p100.protein)}P · ${fmtD(p100.fat)}F · ${fmtD(p100.carbs)}C · ${fmt(p100.calories)}kcal <span class="sr-per">/ 100g</span></div>
  </div>`;
}

window._selectFood = function(encoded) {
  try { pendingFood = JSON.parse(decodeURIComponent(encoded)); }
  catch { return; }
  document.getElementById('amountWrap').classList.remove('hidden');
  document.getElementById('selectedFoodName').textContent = pendingFood.name;
  document.getElementById('ingredientAmount').value = '100';
  document.getElementById('ingredientAmount').focus();
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchInput').value = '';
};

window._confirmIngredient = function() {
  if (!pendingFood || !searchTargetMealId) return;
  const amtEl = document.getElementById('ingredientAmount');
  const amountG = Math.max(1, parseInt(amtEl.value) || 100);
  const meal = profile().meals.find(m => m.id === searchTargetMealId);
  if (!meal) return;
  meal.ingredients.push({
    id:     uid(),
    name:   pendingFood.name,
    fdcId:  pendingFood.fdcId || null,
    amountG,
    per100g: pendingFood.per100g
  });
  save();
  window._closeSearch();
  renderSummary();
  renderMeals();
  setTimeout(() => {
    const body = document.getElementById(`body-${searchTargetMealId}`);
    const chev = document.getElementById(`chev-${searchTargetMealId}`);
    if (body) body.classList.add('open');
    if (chev) chev.classList.add('open');
  }, 30);
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
