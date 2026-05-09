const BASE = 'https://api.nal.usda.gov/fdc/v1';

// ── API key stored per profile in localStorage ────────────────────────────────

const ENV_API_KEY = (() => {
  try { return import.meta.env?.VITE_USDA_API_KEY || ''; } catch { return ''; }
})();

export function getApiKey(profileId) {
  return localStorage.getItem(`nutrition_apikey_${profileId}`) || ENV_API_KEY;
}

export function setApiKey(profileId, key) {
  localStorage.setItem(`nutrition_apikey_${profileId}`, key.trim());
}

// ── Search USDA ───────────────────────────────────────────────────────────────

export async function searchFoods(query, apiKey) {
  const url = `${BASE}/foods/search?query=${encodeURIComponent(query)}`
    + `&dataType=Foundation,SR%20Legacy&pageSize=10&api_key=${apiKey}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`USDA ${r.status}`);
  const data = await r.json();
  return (data.foods || []).map(food => ({
    fdcId:   food.fdcId,
    name:    food.description,
    per100g: extractPer100g(food.foodNutrients || [])
  }));
}

function extractPer100g(nutrients) {
  const get = id => {
    const n = nutrients.find(n => n.nutrientId === id);
    return n ? (n.value ?? 0) : 0;
  };
  return {
    calories:  get(1008), protein:   get(1003), fat:       get(1004), carbs:     get(1005),
    vitaminA:  get(1106), vitaminD:  get(1114), vitaminE:  get(1109), vitaminK:  get(1185),
    vitaminC:  get(1162), vitaminB6: get(1175), vitaminB12:get(1178), folate:    get(1190),
    choline:   get(1180), calcium:   get(1087), iron:      get(1089), magnesium: get(1090),
    zinc:      get(1095), potassium: get(1092), selenium:  get(1103), epa:       get(1278),
    dha:       get(1272),
  };
}

export async function getFoodDetail(fdcId, apiKey) {
  const r = await fetch(`${BASE}/food/${fdcId}?api_key=${apiKey}`);
  if (!r.ok) throw new Error(`USDA detail ${r.status}`);
  const data = await r.json();
  const nutrients = (data.foodNutrients || []).map(fn => ({
    nutrientId: fn.nutrient?.id ?? fn.nutrientId,
    value:      fn.amount ?? fn.value ?? 0,
  }));
  return extractPer100g(nutrients);
}
