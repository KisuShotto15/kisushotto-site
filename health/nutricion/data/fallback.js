// Alimentos venezolanos/latinos comunes con macros por 100g
// Usados como fallback cuando USDA no está disponible o no hay API key
export const FALLBACK_FOODS = [
  // Proteínas animales
  { name: 'Huevo entero',                per100g: { calories: 148, protein: 12.6, fat: 9.9,  carbs: 0.7 } },
  { name: 'Muslo de pollo con piel (crudo)', per100g: { calories: 218, protein: 18.8, fat: 14.7, carbs: 0   } },
  { name: 'Pechuga de pollo (cruda)',    per100g: { calories: 120, protein: 22.5, fat: 2.6,  carbs: 0   } },
  { name: 'Carne de res molida 80/20',   per100g: { calories: 254, protein: 17.4, fat: 20.0, carbs: 0   } },
  { name: 'Sardinas en agua (lata)',     per100g: { calories: 142, protein: 24.6, fat: 4.9,  carbs: 0   } },
  { name: 'Sardinas en aceite (lata)',   per100g: { calories: 208, protein: 24.6, fat: 11.5, carbs: 0   } },
  { name: 'Atún en agua (lata)',         per100g: { calories: 109, protein: 25.5, fat: 0.5,  carbs: 0   } },
  { name: 'Chuleta de cerdo',            per100g: { calories: 210, protein: 22.0, fat: 13.0, carbs: 0   } },

  // Lácteos / Quesos
  { name: 'Queso blanco duro venezolano', per100g: { calories: 370, protein: 25.0, fat: 30.0, carbs: 2.0 } },
  { name: 'Queso amarillo (cheddar)',    per100g: { calories: 402, protein: 24.9, fat: 33.1, carbs: 1.3 } },
  { name: 'Leche entera',               per100g: { calories: 61,  protein: 3.2,  fat: 3.3,  carbs: 4.8 } },
  { name: 'Yogur natural entero',       per100g: { calories: 59,  protein: 3.5,  fat: 3.3,  carbs: 4.7 } },
  { name: 'Mantequilla',                per100g: { calories: 717, protein: 0.9,  fat: 81.1, carbs: 0.1 } },
  { name: 'Nata/Crema de leche',        per100g: { calories: 340, protein: 2.0,  fat: 36.0, carbs: 3.0 } },

  // Grasas / Aceites
  { name: 'Aguacate',                   per100g: { calories: 160, protein: 2.0,  fat: 14.7, carbs: 8.5 } },
  { name: 'Aceite de oliva',            per100g: { calories: 884, protein: 0,    fat: 100,  carbs: 0   } },
  { name: 'Aceite de coco',             per100g: { calories: 862, protein: 0,    fat: 99.1, carbs: 0   } },
  { name: 'Aceite de girasol',          per100g: { calories: 884, protein: 0,    fat: 100,  carbs: 0   } },

  // Vegetales
  { name: 'Brócoli',                    per100g: { calories: 34,  protein: 2.8,  fat: 0.4,  carbs: 6.6 } },
  { name: 'Espinaca',                   per100g: { calories: 23,  protein: 2.9,  fat: 0.4,  carbs: 3.6 } },
  { name: 'Vainitas (judías verdes)',   per100g: { calories: 31,  protein: 1.8,  fat: 0.2,  carbs: 7.1 } },
  { name: 'Chayota',                    per100g: { calories: 19,  protein: 0.8,  fat: 0.1,  carbs: 4.5 } },
  { name: 'Auyama (zapallo)',           per100g: { calories: 26,  protein: 1.0,  fat: 0.1,  carbs: 6.5 } },
  { name: 'Tomate',                     per100g: { calories: 18,  protein: 0.9,  fat: 0.2,  carbs: 3.9 } },
  { name: 'Cebolla',                    per100g: { calories: 40,  protein: 1.1,  fat: 0.1,  carbs: 9.3 } },
  { name: 'Ajo',                        per100g: { calories: 149, protein: 6.4,  fat: 0.5,  carbs: 33.1} },
  { name: 'Zanahoria',                  per100g: { calories: 41,  protein: 0.9,  fat: 0.2,  carbs: 9.6 } },
  { name: 'Pepino',                     per100g: { calories: 15,  protein: 0.7,  fat: 0.1,  carbs: 3.6 } },
  { name: 'Lechuga',                    per100g: { calories: 15,  protein: 1.4,  fat: 0.2,  carbs: 2.9 } },
  { name: 'Celery / Apio (tallo)',      per100g: { calories: 16,  protein: 0.7,  fat: 0.2,  carbs: 3.0 } },
  { name: 'Pimentón rojo',             per100g: { calories: 31,  protein: 1.0,  fat: 0.3,  carbs: 6.0 } },

  // Carbohidratos
  { name: 'Arroz blanco cocido',        per100g: { calories: 130, protein: 2.7,  fat: 0.3,  carbs: 28.2} },
  { name: 'Papa/Patata',               per100g: { calories: 77,  protein: 2.0,  fat: 0.1,  carbs: 17.5} },
  { name: 'Plátano maduro',            per100g: { calories: 89,  protein: 1.1,  fat: 0.3,  carbs: 22.8} },
  { name: 'Caraotas negras cocidas',   per100g: { calories: 132, protein: 8.9,  fat: 0.5,  carbs: 23.7} },
  { name: 'Caraotas rojas cocidas',    per100g: { calories: 127, protein: 8.7,  fat: 0.5,  carbs: 22.8} },
  { name: 'Lentejas cocidas',          per100g: { calories: 116, protein: 9.0,  fat: 0.4,  carbs: 20.1} },
  { name: 'Arepa de maíz (cocida)',    per100g: { calories: 195, protein: 3.8,  fat: 1.0,  carbs: 42.0} },
  { name: 'Pan de trigo',              per100g: { calories: 265, protein: 9.0,  fat: 3.2,  carbs: 49.0} },
  { name: 'Avena',                     per100g: { calories: 389, protein: 16.9, fat: 6.9,  carbs: 66.3} },
];
