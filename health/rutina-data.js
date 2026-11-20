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
  watch:"Si el talón se levanta, acerca el pie. Esa es la señal de que fuiste muy lejos."},

 {name:"Respiración para dormir",dose:"1 min · 4-7-8",q:"4-7-8 breathing technique",
  phases:[{l:"Respira 4-7-8",s:60,cues:[{t:20,say:"Suelta los hombros"},{t:40,say:"Una más, lento"}]}],
  steps:["Acostado o sentado, una mano en el abdomen.",
         "Inhala por la nariz contando 4.",
         "Aguanta el aire contando 7.",
         "Exhala lento por la boca contando 8. Repite 3 o 4 veces."],
  watch:"Si te mareas, acorta la retención. La idea es bajar el pulso, no forzar."}
]}];

/* ---------- rutinas: la de estiramiento viene incluida; las demas las crea el usuario ---------- */
export const BLOCK_NAMES=['Movilidad','Equilibrio','Estiramiento y respiración'];
// Rutina de noche (wind-down): todos los ejercicios, una serie de cada uno
export const BUILTIN={id:'estiramiento',name:'Rutina de noche',builtin:true,
  note:'Para cerrar el día: movilidad suave → equilibrio → estiramiento → respiración. Una serie de cada uno; después, a dormir.',
  blocks:DATA.map((b,k)=>({name:BLOCK_NAMES[k]||b.block,items:b.items}))};

// Ejercicio propio: {name,type:'reps'|'time',sets,reps,secs,rest,kg,sides,note}
// y opcionales: fail (al fallo), range ('6-10'), rir ('1-2'), ss (letra de
// superserie: los seguidos con la misma letra se alternan), warm (series de
// calentamiento al 50 %), w (lleva peso: el kg se ve siempre), step (kg por toque)
export function phasesOf(x){
  const out=[],sides=x.sides?['derecho','izquierdo']:[''];
  for(let w=1;w<=(x.warm||0);w++)out.push({l:`Calentamiento ${w}/${x.warm}`,s:0,reps:x.reps,warm:true,set:0,side:null});
  if(x.warm&&x.rest)out.push({l:'Descanso',s:60,rest:true});
  for(let s=1;s<=x.sets;s++){
    sides.forEach(sd=>out.push({l:`Serie ${s}/${x.sets}`+(sd?' · '+sd:''),s:x.type==='time'?x.secs:0,reps:x.type==='reps'?x.reps:0,set:s,side:sd||null}));
    if(x.rest&&s<x.sets)out.push({l:'Descanso',s:x.rest,rest:true});
  }
  return out;
}
export const doseOf=x=>`${x.sets} × ${x.fail?'al fallo':x.type==='time'?x.secs+' s':(x.range||x.reps)+' reps'}${x.sides?' c/lado':''}${x.rir?' · RIR '+x.rir:''}${x.kg?' · '+x.kg+' kg':''}`;
// mini: "modo minimo" para dias malos (~10 min que igual cuentan): la incluida con
// la mitad del tiempo por fase; las propias, 1 serie por ejercicio y descansos cortos.
// deload: semana de descarga (mitad de las series, mismo peso)
export function compile(r,mini=false,deload=false){
  if(r.builtin){
    // una serie de cada ejercicio: fuera las repeticiones ("Serie 2 · …")
    // y la movilidad (bloque 1) a la mitad: de noche solo es para soltar
    const half=p=>({...p,s:Math.max(15,Math.round(p.s/2)),cues:p.cues?.map(c=>({...c,t:Math.round(c.t/2)}))});
    const its=r.blocks.flatMap((b,bi)=>b.items.map(it=>({...it,block:b.name,
      phases:it.phases.filter(p=>!/^Serie [2-9]/.test(p.l)).map(p=>({...(bi===0?half(p):p),l:p.l.replace(/^Serie 1 · /,'')})),
      dose:bi===0?it.dose.replace(/1 min/,'60 s').replace(/(\d+) s/,(m,n)=>Math.max(15,Math.round(n/2))+' s'):it.dose.replace(/^\d+ × /,'')})));
    return mini?its.map(it=>({...it,phases:it.phases.map(p=>({...p,s:Math.max(15,Math.round(p.s/2)),
      cues:p.cues?.map(c=>({...c,t:Math.round(c.t/2)}))}))})):its;
  }
  // restBetween: descanso entre un ejercicio (o superserie) y el siguiente
  const rb=mini?Math.min(r.restBetween||0,60):r.restBetween;
  const between=()=>({l:'Descanso',s:rb,rest:true,between:true});
  const one=x=>mini?{...x,sets:1,warm:0}:deload?{...x,sets:Math.ceil(x.sets/2)}:x;
  const info=(y,j)=>({src:j,kg:y.kg||null,name:y.name,dose:doseOf(y),note:y.note||'',sets:y.sets,reps:y.type==='reps'?y.reps:0,
    fail:!!y.fail,sides:!!y.sides,range:y.range||null,rir:y.rir||null,w:!!y.w,step:y.step||null});
  // Grupos: ejercicios seguidos con la misma letra de superserie
  const groups=[];
  (r.items||[]).forEach((x,j)=>{const g=groups[groups.length-1];
    if(x.ss&&g&&g.ss===x.ss)g.list.push({x,j});else groups.push({ss:x.ss||null,list:[{x,j}]});});
  return groups.map((g,gi)=>{
    const tail=rb>0&&gi<groups.length-1?[between()]:[];
    if(g.list.length===1){
      const {x,j}=g.list[0],y=one(x);
      return {...info(y,j),phases:[...phasesOf(y),...tail],steps:[],q:y.name+' exercise',block:''};
    }
    // Superserie: A1 serie 1, A2 serie 1, descanso, A1 serie 2... (sin descanso entre A1 y A2)
    const ys=g.list.map(({x})=>one(x)),exs=ys.map((y,k)=>info(y,g.list[k].j));
    const n=Math.max(...ys.map(y=>y.sets)),rest=ys[0].rest,ph=[];
    ys.forEach((y,k)=>{for(let w=1;w<=(y.warm||0);w++)ph.push({l:`Calentamiento ${w}/${y.warm}`,s:0,reps:y.reps,warm:true,set:0,side:null,ex:k});});
    if(ph.length&&rest)ph.push({l:'Descanso',s:60,rest:true});
    for(let s=1;s<=n;s++){
      ys.forEach((y,k)=>{if(y.sets<s)return;
        (y.sides?['derecho','izquierdo']:['']).forEach(sd=>ph.push({l:`Serie ${s}/${y.sets}`+(sd?' · '+sd:''),
          s:y.type==='time'?y.secs:0,reps:y.type==='reps'?y.reps:0,set:s,side:sd||null,ex:k}));});
      if(rest&&s<n)ph.push({l:'Descanso',s:rest,rest:true});
    }
    return {src:g.list[0].j,exs,ss:g.ss,name:exs.map(e=>e.name).join(' + '),dose:`Superserie ${g.ss} · ${n} ${n===1?'ronda':'rondas'}`,
      phases:[...ph,...tail],steps:[],note:'',q:exs[0].name+' exercise',block:'',sets:n,reps:0};
  });
}
// Duracion estimada: las series por repeticiones cuentan ~3 s por rep
export const dur=it=>it.phases.reduce((a,p)=>a+(p.s||p.reps*3),0);

// Lista corta (nombre, dosis, duracion) para Hoy
export const listOf=r=>compile(r).map(it=>({name:it.name,dose:it.dose,dur:dur(it)}));

// Plantillas para "+ Nueva rutina": A/B con superseries (v2). Compuestos a RIR
// 1-2, aislamiento a RIR 0-1; cuando haces el tope del rango en todas las series,
// sube el peso. Semana A-B-A-B-A-B + descanso; descarga cada 6 semanas.
const RC='RIR 1-2: para cuando te queden 1-2 reps limpias. Casi todo el estímulo con mucha menos fatiga. Tope del rango en todas las series → sube el peso.';
const RI='Aislamiento: RIR 0-1 (puedes llegar al fallo). Tope del rango en todas las series → sube el peso.';
const ex=(name,o={})=>({name,type:'reps',sets:3,reps:8,secs:30,rest:0,kg:null,sides:false,w:true,note:RC,...o});
export const TEMPLATES=[
  {key:'A',v:2,name:'Día A · Empuje + cuádriceps',restBetween:90,items:[
    ex('Floor press con mancuernas',{ss:'A',range:'6-10',reps:6,rir:'1-2',rest:120,warm:2,step:1,note:'Antes: 2 series de calentamiento al 50 % del peso. '+RC}),
    ex('Búlgara con mancuernas',{ss:'A',range:'8-12',reps:8,rir:'1-2',rest:120,sides:true,step:1}),
    ex('Overhead press con barra',{ss:'B',range:'6-10',reps:6,rir:'1-2',rest:120,step:2.5}),
    ex('Goblet squat',{ss:'B',range:'10-15',reps:10,rir:'1-2',rest:120,step:1}),
    ex('Elevaciones laterales',{ss:'C',range:'12-15',reps:12,rir:'0-1',rest:75,step:1,note:RI}),
    ex('Extensión de tríceps sobre la cabeza',{ss:'C',range:'10-12',reps:10,rir:'0-1',rest:75,step:1,note:RI}),
    ex('Elevación de pantorrilla a una pierna',{ss:'D',range:'12-20',reps:12,rir:'0',rest:60,sides:true,w:false,note:'RIR 0: hasta el fallo. Pausa de 1 s arriba y abajo. Con 20+ reps, sostén una mancuerna.'}),
    ex('Pallof press con mancuerna',{ss:'D',sets:2,range:'12',reps:12,rest:60,sides:true,step:1,note:'Antirrotación: el torso no gira. 12 por lado.'}),
  ]},
  {key:'B',v:2,name:'Día B · Tirón + cadena posterior',restBetween:90,items:[
    ex('Dominadas',{ss:'A',range:'6-12',reps:6,rir:'1-2',rest:120,warm:2,w:false,note:'Antes: 2 series fáciles de calentamiento (pocas reps). '+RC+' Con 12 en todas las series, añade lastre.'}),
    ex('Peso muerto rumano con barra',{ss:'A',range:'8-12',reps:8,rir:'1-2',rest:120,step:2.5}),
    ex('Remo a una mano',{ss:'B',range:'8-12',reps:8,rir:'1-2',rest:120,sides:true,step:1}),
    ex('Rueda abdominal',{ss:'B',range:'8-15',reps:8,rir:'1',rest:120,w:false,note:'RIR 1. Rango completo sin arquear la espalda baja.'}),
    ex('Rear delt fly',{ss:'C',range:'12-20',reps:12,rir:'0-1',rest:75,step:1,note:RI}),
    ex('Encogimiento de hombros con barra',{ss:'C',range:'12-15',reps:12,rir:'0-1',rest:75,step:2.5,note:RI}),
    ex('Curl con mancuernas',{ss:'D',range:'8-12',reps:8,rir:'0-1',rest:60,step:1,note:RI}),
    ex('Curl martillo',{ss:'D',sets:2,range:'10-12',reps:10,rir:'0-1',rest:60,step:1,note:RI}),
  ]},
];
// Nombres de la A/B anterior (al fallo, sin superseries): se reemplaza al cargar la nueva
export const OLD_AB=['Día A · Empuje + piernas','Día B · Jalón + core'];
