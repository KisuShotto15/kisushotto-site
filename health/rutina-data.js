// health/rutina-data.js — la rutina de estiramiento incluida y como se arma
// cualquier rutina (fases, dosis, duracion). Lo usan Rutina y Hoy.
// cues: avisos por voz dentro de una fase ({t: segundos desde el inicio, say}).
export const DATA=[
{block:"Bloque 1 — Activación (5 min)",items:[
 {name:"Círculos de cadera",dose:"30 s cada sentido",q:"hip circles exercise standing",
  phases:[{l:"Sentido horario",s:30},{l:"Sentido antihorario",s:30}],
  steps:["Pies separados al ancho de los hombros, manos en la cintura.",
         "Mantén los pies fijos y las rodillas suaves, sin bloquear.",
         "Dibuja un círculo amplio con la cadera, como si trazaras el borde de un plato grande.",
         "Movimiento lento y controlado: cada círculo completo debe tomar unos 3 segundos."],
  watch:"No muevas los hombros ni el torso. Solo la cadera gira."},

 {name:"Círculos de hombro",dose:"30 s cada sentido",q:"arm circles shoulder warmup",
  phases:[{l:"Hacia adelante",s:30,cues:[{t:20,say:"Últimos 10 segundos, círculos amplios"}]},{l:"Hacia atrás",s:30,cues:[{t:20,say:"Últimos 10 segundos, círculos amplios"}]}],
  steps:["De pie, brazos extendidos a los lados formando una T.",
         "Comienza con círculos pequeños y agrándalos progresivamente.",
         "El movimiento nace del hombro, no del codo ni de la muñeca.",
         "Últimos 10 segundos: círculos lo más amplios que puedas."],
  watch:"No encojas los hombros hacia las orejas. Mantén el cuello largo."},

 {name:"Balanceo de pierna",dose:"30 s cada pierna",q:"leg swings dynamic stretch",
  phases:[{l:"Pierna derecha",s:30},{l:"Pierna izquierda",s:30}],
  steps:["Apóyate con una mano en la pared o en el marco de la puerta.",
         "Balancea la pierna libre hacia adelante y hacia atrás como un péndulo.",
         "Pierna relajada, no tensa. La gravedad hace la mitad del trabajo.",
         "Aumenta el rango progresivamente, nunca de golpe."],
  watch:"Torso erguido. Si te inclinas hacia atrás al subir la pierna, redujiste el rango."},

 {name:"World's Greatest Stretch",dose:"1 min cada lado",q:"world's greatest stretch exercise",
  phases:[{l:"Lado derecho",s:60},{l:"Lado izquierdo",s:60}],
  steps:["Desde posición de plancha, lleva el pie derecho junto a la mano derecha.",
         "Baja el codo derecho hacia el piso, cerca del pie. Mantén 2 segundos.",
         "Sube el brazo derecho rotando el torso, mirando la mano que apunta al techo.",
         "Regresa y repite el ciclo durante todo el minuto, sin apuro."],
  watch:"La rodilla trasera estirada y la cadera baja. Ahí está el estiramiento del flexor."},

 {name:"Rotación de tobillo",dose:"30 s cada pie",q:"ankle circles mobility exercise",
  phases:[{l:"Pie derecho",s:30,cues:[{t:15,say:"Cambia de sentido"}]},{l:"Pie izquierdo",s:30,cues:[{t:15,say:"Cambia de sentido"}]}],
  steps:["Apóyate si lo necesitas y levanta un pie del piso.",
         "Dibuja círculos amplios con la punta del pie, 15 s en cada sentido.",
         "Busca el rango máximo en cada dirección, sin forzar.",
         "Si escuchas chasquidos sin dolor, es normal."],
  watch:"Mueve solo el tobillo. La rodilla y la pierna se quedan quietas."}
]},

{block:"Bloque 2 — Equilibrio funcional (10 min)",items:[
 {name:"Balance a una pierna · ojos abiertos",dose:"2 × 30 s cada pierna",q:"single leg balance exercise standing",
  phases:[{l:"Serie 1 · derecha",s:30},{l:"Serie 1 · izquierda",s:30},{l:"Serie 2 · derecha",s:30},{l:"Serie 2 · izquierda",s:30}],
  steps:["Párate sobre una pierna, rodilla ligeramente flexionada.",
         "La otra rodilla sube hasta la altura de la cadera.",
         "Fija la mirada en un punto de la pared a la altura de los ojos.",
         "Reparte el peso entre el talón y los dedos. Deja que el pie trabaje."],
  watch:"Si te tambaleas mucho, el problema es el tobillo, no el equilibrio. Mejora con las semanas."},

 {name:"Balance a una pierna · ojos cerrados",dose:"2 × 20 s cada pierna",q:"single leg balance eyes closed",
  phases:[{l:"Serie 1 · derecha",s:20},{l:"Serie 1 · izquierda",s:20},{l:"Serie 2 · derecha",s:20},{l:"Serie 2 · izquierda",s:20}],
  steps:["Misma posición que el ejercicio anterior.",
         "Cierra los ojos por completo antes de que empiece el conteo.",
         "Sin la vista, el tobillo y el oído interno hacen todo el trabajo.",
         "Si pierdes el equilibrio, reposiciona y continúa sin detener el reloj."],
  watch:"Hazlo cerca de una pared. Es normal durar mucho menos que con los ojos abiertos."},

 {name:"Single-leg RDL sin peso",dose:"2 × 8 reps cada pierna",q:"single leg romanian deadlift bodyweight",
  phases:[{l:"Serie 1 · derecha",s:40},{l:"Serie 1 · izquierda",s:40},{l:"Serie 2 · derecha",s:40},{l:"Serie 2 · izquierda",s:40}],
  steps:["Párate sobre una pierna, la otra extendida hacia atrás.",
         "Empuja la cadera hacia atrás mientras el torso baja al frente.",
         "El cuerpo forma una línea recta desde la cabeza hasta el talón trasero.",
         "Baja hasta tocar el piso con las manos, sube apretando el glúteo."],
  watch:"Espalda plana, nunca redondeada. La cadera no debe abrirse hacia un lado."},

 {name:"Bird dog",dose:"2 × 10 reps cada lado",q:"bird dog exercise form",
  phases:[{l:"Serie 1 · brazo derecho",s:40},{l:"Serie 1 · brazo izquierdo",s:40},{l:"Serie 2 · brazo derecho",s:40},{l:"Serie 2 · brazo izquierdo",s:40}],
  steps:["En cuatro apoyos: manos bajo los hombros, rodillas bajo la cadera.",
         "Extiende brazo derecho y pierna izquierda al mismo tiempo.",
         "Mantén 2 segundos en la extensión máxima.",
         "Regresa controlado sin tocar el piso y repite."],
  watch:"La cadera no debe rotar. Imagina un vaso de agua en tu espalda baja."},

 {name:"Búlgara isométrica · sin peso",dose:"2 × 20 s cada pierna",q:"bulgarian split squat isometric hold",
  phases:[{l:"Serie 1 · derecha",s:20},{l:"Serie 1 · izquierda",s:20},{l:"Serie 2 · derecha",s:20},{l:"Serie 2 · izquierda",s:20}],
  steps:["Empeine del pie trasero sobre una silla o el borde de la cama.",
         "Pie delantero suficientemente adelante para que la rodilla no pase los dedos.",
         "Baja hasta que el muslo delantero quede casi paralelo al piso.",
         "Mantén esa posición todo el tiempo, sin subir ni bajar."],
  watch:"Torso vertical. El peso en el talón delantero, no en la punta."}
]},

{block:"Bloque 3 — Estiramiento estático (5 min)",items:[
 {name:"Pecho en marco de puerta",dose:"45 s cada lado",q:"doorway chest stretch",
  phases:[{l:"Lado derecho",s:45},{l:"Lado izquierdo",s:45}],
  steps:["Antebrazo apoyado en el marco, codo a la altura del hombro.",
         "Da un paso adelante con la pierna del mismo lado.",
         "Gira el torso lentamente en dirección contraria al brazo apoyado.",
         "Respira profundo: en cada exhalación cede un poco más."],
  watch:"Estiramiento en el pecho, no en el hombro. Si duele el hombro, baja el codo."},

 {name:"Hombro cruzado",dose:"30 s cada lado",q:"cross body shoulder stretch",
  phases:[{l:"Lado derecho",s:30},{l:"Lado izquierdo",s:30}],
  steps:["Cruza el brazo derecho por delante del pecho, bien extendido.",
         "Con el antebrazo izquierdo, engánchalo y acércalo al cuerpo.",
         "Mantén el hombro derecho hacia abajo, no lo dejes subir.",
         "Presión constante, sin rebotes."],
  watch:"Si no sientes nada, estás subiendo el hombro. Bájalo y aumenta la presión."},

 {name:"Flexor de cadera",dose:"45 s cada lado",q:"kneeling hip flexor stretch",
  phases:[{l:"Lado derecho",s:45},{l:"Lado izquierdo",s:45}],
  steps:["Rodilla derecha en el piso sobre algo acolchado, pie izquierdo adelante.",
         "Aprieta el glúteo derecho con fuerza. Esto es lo que activa el estiramiento.",
         "Empuja la cadera hacia adelante manteniendo el torso vertical.",
         "Para más intensidad, sube el brazo derecho e inclínate a la izquierda."],
  watch:"No arquees la espalda baja. El glúteo apretado lo previene."},

 {name:"Isquiotibial",dose:"45 s cada lado",q:"standing hamstring stretch",
  phases:[{l:"Lado derecho",s:45},{l:"Lado izquierdo",s:45}],
  steps:["Talón derecho apoyado en una silla baja o escalón, pierna extendida.",
         "Pie en flexión, dedos apuntando hacia arriba.",
         "Dobla desde la cadera, no desde la espalda, llevando el pecho al muslo.",
         "Mantén la rodilla casi recta pero sin bloquearla por completo."],
  watch:"Si redondeas la espalda, estiras la espalda y no el isquiotibial. Baja la altura."},

 {name:"Pantorrilla en pared",dose:"30 s cada lado",q:"calf stretch against wall",
  phases:[{l:"Lado derecho",s:30},{l:"Lado izquierdo",s:30}],
  steps:["Manos en la pared, pierna derecha atrás bien extendida.",
         "Talón trasero completamente pegado al piso.",
         "Empuja la pared mientras acercas la cadera hacia ella.",
         "Dedos del pie trasero apuntando al frente, no hacia afuera."],
  watch:"Si el talón se levanta, acerca el pie. Esa es la señal de que fuiste muy lejos."}
]}];

/* ---------- rutinas: la de estiramiento viene incluida; las demas las crea el usuario ---------- */
export const BLOCK_NAMES=['Activación','Equilibrio funcional','Estiramiento estático'];
export const BUILTIN={id:'estiramiento',name:'Equilibrio + estiramiento',builtin:true,
  note:'Orden fijo: activación → equilibrio → estático. Nunca estiramiento estático antes de entrenar con pesas.',
  blocks:DATA.map((b,k)=>({name:BLOCK_NAMES[k]||b.block,items:b.items}))};

// Ejercicio propio: {name,type:'reps'|'time',sets,reps,secs,rest,kg,sides,note}
export function phasesOf(x){
  const out=[],sides=x.sides?['derecho','izquierdo']:[''];
  for(let s=1;s<=x.sets;s++){
    sides.forEach(sd=>out.push({l:`Serie ${s}/${x.sets}`+(sd?' · '+sd:''),s:x.type==='time'?x.secs:0,reps:x.type==='reps'?x.reps:0}));
    if(x.rest&&s<x.sets)out.push({l:'Descanso',s:x.rest,rest:true});
  }
  return out;
}
export const doseOf=x=>`${x.sets} × ${x.type==='time'?x.secs+' s':x.reps+' reps'}${x.sides?' c/lado':''}${x.kg?' · '+x.kg+' kg':''}`;
export function compile(r){
  if(r.builtin)return r.blocks.flatMap(b=>b.items.map(it=>({...it,block:b.name})));
  // restBetween: descanso entre un ejercicio y el siguiente (ultima fase del ejercicio)
  const n=(r.items||[]).length,between=x=>({l:'Descanso',s:r.restBetween,rest:true,between:true});
  return (r.items||[]).map((x,j)=>({src:j,kg:x.kg||null,name:x.name,dose:doseOf(x),
    phases:r.restBetween>0&&j<n-1?[...phasesOf(x),between(x)]:phasesOf(x),steps:[],note:x.note||'',q:x.name+' exercise',block:'',sets:x.sets,reps:x.type==='reps'?x.reps:0}));
}
// Duracion estimada: las series por repeticiones cuentan ~3 s por rep
export const dur=it=>it.phases.reduce((a,p)=>a+(p.s||p.reps*3),0);

// Lista corta (nombre, dosis, duracion) para Hoy
export const listOf=r=>compile(r).map(it=>({name:it.name,dose:it.dose,dur:dur(it)}));
