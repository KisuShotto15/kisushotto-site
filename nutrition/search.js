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
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`USDA ${r.status}`);
  const data = await r.json();
  return (data.foods || []).map(food => ({
    fdcId:   food.fdcId,
    name:    food.description,
    per100g: extractPer100g(food.foodNutrients || [])
  }));
}

// number → nutrientId for search endpoint (AbridgedFoodNutrient format)
const NUTRIENT_NUM_MAP = {
  '203':1003,'204':1004,'205':1005,'208':1008,
  '298':1004, // Total fat NLEA (Foundation foods) → fat slot
  '318':1106,'328':1114,'323':1109,'430':1185,
  '401':1162,'415':1175,'418':1178,'435':1190,
  '421':1180,'301':1087,'303':1089,'304':1090,
  '309':1095,'306':1092,'317':1103,'629':1278,'621':1272,
  '606':1258,'645':1292,'646':1293, // sat/mono/poly fat
};

// nutrientId aliases for Foundation foods that use different IDs
const NUTRIENT_ID_ALIAS = {
  1085: 1004, // Total fat NLEA → fat
};

function extractPer100g(nutrients) {
  const map = new Map();
  for (const n of nutrients) {
    let id  = n.nutrientId || NUTRIENT_NUM_MAP[n.number];
    const val = n.value ?? n.amount ?? 0;
    if (id) {
      id = NUTRIENT_ID_ALIAS[id] ?? id;
      if (!map.has(id)) map.set(id, val); // prefer first match
    }
  }
  const get = id => map.get(id) ?? 0;
  const fat = get(1004), protein = get(1003), carbs = get(1005);
  let calories = get(1008);
  // Foundation foods lack Energy nutrient — derive from macros
  if (calories === 0 && (fat > 0 || protein > 0 || carbs > 0)) {
    calories = Math.round(fat * 9 + protein * 4 + carbs * 4);
  }
  return {
    calories, protein, fat, carbs,
    vitaminA:  get(1106), vitaminD:  get(1114), vitaminE:  get(1109), vitaminK:  get(1185),
    vitaminC:  get(1162), vitaminB6: get(1175), vitaminB12:get(1178), folate:    get(1190),
    choline:   get(1180), calcium:   get(1087), iron:      get(1089), magnesium: get(1090),
    zinc:      get(1095), potassium: get(1092), selenium:  get(1103), epa:       get(1278) * 1000,
    dha:       get(1272) * 1000,
    satFat:    get(1258), monoFat:   get(1292), polyFat:   get(1293),
  };
}

export async function getFoodDetail(fdcId, apiKey) {
  const r = await fetch(`${BASE}/food/${fdcId}?api_key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`USDA detail ${r.status}`);
  const data = await r.json();
  const nutrients = (data.foodNutrients || []).map(fn => ({
    nutrientId: fn.nutrient?.id ?? fn.nutrientId,
    value:      fn.amount ?? fn.value ?? 0,
  }));
  return extractPer100g(nutrients);
}
