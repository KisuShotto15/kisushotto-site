// cache.js — stale-while-revalidate sobre sessionStorage.
// Cada pestana del journal es un HTML distinto, asi que al navegar se pierde
// todo el estado en memoria y se vuelve a pedir lo mismo. Esto hace que la
// vuelta a una pestana pinte al instante con lo ultimo que se vio y refresque
// por detras. Es sessionStorage a proposito: se limpia al cerrar la pestana.

const PREFIX = 'tj_cache:';

function read(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function write(key, data) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch { /* cuota llena: seguir sin cache */ }
}

export function invalidate(prefix = '') {
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith(PREFIX + prefix)) sessionStorage.removeItem(k);
    }
  } catch { /* ignorar */ }
}

/**
 * Devuelve lo cacheado al instante (si no expiro) y revalida por detras.
 * @param key    identificador estable de la peticion
 * @param fetcher   () => Promise<data>
 * @param onUpdate  se llama si los datos frescos difieren de los cacheados
 * @param ttl    ms que el dato se considera fresco; pasado eso se espera al fetch
 */
export async function swr(key, fetcher, onUpdate, ttl = 60000) {
  const hit = read(key);
  const age = hit ? Date.now() - hit.t : Infinity;

  if (hit && age < ttl) {
    // Fresco: se sirve del cache y no se vuelve a pedir
    return hit.data;
  }

  if (hit) {
    // Viejo pero usable: se pinta ya y se revalida sin bloquear
    fetcher().then(fresh => {
      write(key, fresh);
      if (onUpdate && JSON.stringify(fresh) !== JSON.stringify(hit.data)) onUpdate(fresh);
    }).catch(() => { /* si falla, queda lo cacheado */ });
    return hit.data;
  }

  const fresh = await fetcher();
  write(key, fresh);
  return fresh;
}
