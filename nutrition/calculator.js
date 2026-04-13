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
