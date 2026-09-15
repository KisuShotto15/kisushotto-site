// El veredicto del panel de salud, aparte de las consultas que lo alimentan.
//
// Vive solo aqui porque es la definicion de "el sistema esta bien", y esa
// definicion tiene que ser una sola: si el punto rojo del boton y el detalle del
// panel pudieran discrepar, el panel dejaria de servir para lo unico que sirve.

// Cuantos segundos puede pasar el tick sin aparecer antes de darlo por caido. El
// Durable Object dispara cada ~30 s; con bots encendidos nunca espacia mas. 90 s
// son tres ciclos: suficiente para no dar falsas alarmas por una invocacion lenta.
export const TICK_STALE_S = 90;
// Cuanto puede llevar un bot sin reprecio antes de considerarlo desatendido. El
// tick lo reclama cada ~30 s, asi que 5 minutos solo pasan si se esta quedando
// fuera del LIMIT o si su tick falla siempre.
export const BOT_STALE_MIN = 5;

// tick: fila agregada de tick_runs. bots: conteos de bot_state.
// Devuelve la lista de problemas en lenguaje llano; vacia significa que todo va.
export function healthProblems(tick = {}, bots = {}) {
  const p = [];
  if (tick.last_age_s == null) {
    p.push('El tick no ha corrido nunca, o no queda registro de la última vez.');
  } else if (tick.last_age_s > TICK_STALE_S) {
    p.push('El tick lleva ' + tick.last_age_s + ' s sin aparecer: ahora mismo no se está repreciando nadie.');
  }
  // Un tick lento se ve en la duracion. Uno que no llego a existir solo se ve
  // aqui: mide que el scheduler de Cloudflare siga disparando.
  if (tick.max_gap_s != null && tick.max_gap_s > TICK_STALE_S) {
    p.push('Hubo un hueco de ' + tick.max_gap_s + ' s entre ticks en la última hora.');
  }
  if (bots.stale) {
    p.push(bots.stale + (bots.stale === 1 ? ' bot lleva' : ' bots llevan') +
      ' más de ' + BOT_STALE_MIN + ' min sin reprecio.');
  }
  if (bots.failing) {
    p.push(bots.failing + (bots.failing === 1 ? ' bot está' : ' bots están') + ' en error.');
  }
  // El tope alcanzado es el aviso que llega ANTES de que a alguien se le pare el
  // bot: significa que la consulta se llevo el LIMIT entero y puede haber cola.
  if (tick.capped) {
    p.push('El tick llegó al tope de usuarios ' + tick.capped +
      (tick.capped === 1 ? ' vez' : ' veces') + ' en la última hora: puede haber gente esperando.');
  }
  return p;
}
