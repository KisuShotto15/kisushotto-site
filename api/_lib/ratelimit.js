// Rate limit en memoria (por instancia serverless). Aproximado pero suficiente
// para frenar fuerza bruta casual. Para limite global exacto haria falta KV/Redis.
const buckets = new Map(); // key -> { count, resetAt }

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown')
    .split(',')[0].trim();
}

// Devuelve segundos a esperar si se excedio el limite, o null si esta dentro.
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let e = buckets.get(key);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + windowMs }; buckets.set(key, e); }
  e.count++;
  if (buckets.size > 5000) { for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k); }
  return e.count > max ? Math.ceil((e.resetAt - now) / 1000) : null;
}
