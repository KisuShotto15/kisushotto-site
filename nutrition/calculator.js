// ── TDEE ─────────────────────────────────────────────────────────────────────

export function calcBMR(weight, height, age, gender) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  return Math.round(gender === 'male' ? base + 5 : base - 161);
}

export function calcTDEE(bmr, activity) {
  return Math.round(bmr * parseFloat(activity));
}

export function calcTarget(tdee, goal, goalPct) {
  const pct = parseFloat(goalPct) || 0;
  if (goal === 'deficit')  return Math.round(tdee * (1 - pct / 100));
  if (goal === 'surplus')  return Math.round(tdee * (1 + pct / 100));
  return tdee;
}

// ── Macros ────────────────────────────────────────────────────────────────────

export function mealMacros(ingredients) {
  return ingredients.reduce((acc, ing) => {
    if (ing.disabled) return acc;
    const f = ing.amountG / 100;
    acc.calories += (ing.per100g.calories || 0) * f;
    acc.protein  += (ing.per100g.protein  || 0) * f;
    acc.fat      += (ing.per100g.fat      || 0) * f;
    acc.carbs    += (ing.per100g.carbs    || 0) * f;
    return acc;
  }, { calories: 0, protein: 0, fat: 0, carbs: 0 });
}

export function totalMacros(meals) {
  return meals.reduce((acc, meal) => {
    const m = mealMacros(meal.ingredients);
    acc.calories += m.calories;
    acc.protein  += m.protein;
    acc.fat      += m.fat;
    acc.carbs    += m.carbs;
    return acc;
  }, { calories: 0, protein: 0, fat: 0, carbs: 0 });
}

// ── Micronutrients ───────────────────────────────────────────────────────────

export const MICROS_DEF = [
  { key: 'vitaminA',  label: 'Vitamina A',        unit: 'µg', rda: { male: 900,  female: 700  } },
  { key: 'vitaminD',  label: 'Vitamina D',        unit: 'µg', rdaFn: (age) => age >= 70 ? 20 : 15 },
  { key: 'vitaminE',  label: 'Vitamina E',        unit: 'mg', rda: { male: 15,   female: 15   } },
  { key: 'vitaminK',  label: 'Vitamina K',        unit: 'µg', rda: { male: 120,  female: 90   } },
  { key: 'vitaminC',  label: 'Vitamina C',        unit: 'mg', rda: { male: 90,   female: 75   } },
  { key: 'vitaminB6', label: 'Vitamina B6',       unit: 'mg', rdaFn: (age, g) => age >= 51 ? (g === 'male' ? 1.7 : 1.5) : 1.3 },
  { key: 'vitaminB12',label: 'Vitamina B12',      unit: 'µg', rda: { male: 2.4,  female: 2.4  } },
  { key: 'folate',    label: 'Folato (B9)',        unit: 'µg', rda: { male: 400,  female: 400  } },
  { key: 'choline',   label: 'Colina',            unit: 'mg', rda: { male: 550,  female: 425  } },
  { key: 'calcium',   label: 'Calcio',            unit: 'mg', rdaFn: (age) => age >= 51 ? 1200 : 1000 },
  { key: 'iron',      label: 'Hierro',            unit: 'mg', rdaFn: (age, g) => (g === 'female' && age <= 50) ? 18 : 8 },
  { key: 'magnesium', label: 'Magnesio',          unit: 'mg', rda: { male: 420,  female: 320  } },
  { key: 'zinc',      label: 'Zinc',              unit: 'mg', rda: { male: 11,   female: 8    } },
  { key: 'potassium', label: 'Potasio',           unit: 'mg', rda: { male: 3400, female: 2600 } },
  { key: 'selenium',  label: 'Selenio',           unit: 'µg', rda: { male: 55,   female: 55   } },
  { key: 'omega3',    label: 'Omega-3 (EPA+DHA)', unit: 'mg', rda: { male: 1600, female: 1100 } },
];

export function calcRDA(age, gender) {
  const a = parseInt(age) || 30;
  const g = gender || 'male';
  const result = {};
  for (const def of MICROS_DEF) {
    result[def.key] = def.rdaFn ? def.rdaFn(a, g) : (def.rda[g] ?? def.rda.male);
  }
  return result;
}

export function totalMicros(meals, microCache) {
  const totals = {};
  for (const def of MICROS_DEF) totals[def.key] = 0;
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      if (ing.disabled) continue;
      if (!ing.fdcId) continue;
      const cached = microCache[ing.fdcId];
      if (!cached) continue;
      const f = ing.amountG / 100;
      for (const def of MICROS_DEF) {
        if (def.key === 'omega3') {
          totals.omega3 += ((cached.epa || 0) + (cached.dha || 0)) * f;
        } else {
          totals[def.key] += (cached[def.key] || 0) * f;
        }
      }
    }
  }
  return totals;
}

// ── Scale portions ────────────────────────────────────────────────────────────

export function scalePortions(meals, targetKcal) {
  const current = totalMacros(meals).calories;
  if (!current) return meals;
  const ratio = targetKcal / current;
  return meals.map(meal => ({
    ...meal,
    ingredients: meal.ingredients.map(ing => ({
      ...ing,
      amountG: Math.max(1, Math.round(ing.amountG * ratio))
    }))
  }));
}
