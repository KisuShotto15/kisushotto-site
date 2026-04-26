const BASE = 'https://api.nal.usda.gov/fdc/v1';

// ── API key stored per profile in localStorage ────────────────────────────────

const ENV_API_KEY = import.meta.env.VITE_USDA_API_KEY || '';

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
    calories: get(1008),
    protein:  get(1003),
    fat:      get(1004),
    carbs:    get(1005)
  };
}
