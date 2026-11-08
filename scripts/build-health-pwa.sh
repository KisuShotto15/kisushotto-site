#!/usr/bin/env bash
# Builds a self-contained health-pwa/ directory for deployment to health.kisushotto.com
set -e

OUT="health-pwa"
rm -rf "$OUT"
mkdir -p "$OUT/icons" "$OUT/images"

# Toda la app vive en health/: shell, Hoy, Rutina, Nutricion y Metricas.
# Las rutas son relativas, asi que funciona igual aqui y en kisushotto.com/health/.
cp health/index.html health/hoy.html health/rutina.html health/auth.js health/theme.css health/swipe.js "$OUT/"
cp -r health/nutricion health/metricas "$OUT/"
# En el subdominio el manifest vive en la raiz
sed -i 's|href="/manifests/health.json"|href="/manifest.json"|g' "$OUT/index.html"

# Manifest raiz con start_url/scope en "/"
cp public/manifests/health.json "$OUT/manifest.json"
sed -i 's|"start_url": "/health/"|"start_url": "/"|; s|"scope": "/health/"|"scope": "/"|' "$OUT/manifest.json"

# Iconos e imagenes que usan el shell y las pestanas
cp public/icons/health-192.png public/icons/health-512.png "$OUT/icons/"
cp public/images/health-icon.svg public/images/health-favicon.svg \
   public/images/nutrition-favicon.svg public/images/bm-favicon.svg public/images/bm-icon.svg "$OUT/images/"

# Service worker: guarda la app para abrirla sin internet (en el gym con mala
# senal) y maneja el recordatorio diario por push (lo envia habits-worker).
# Estrategia: red primero con tope de 3 s; si no hay red o tarda, la copia guardada.
VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%Y%m%d%H%M%S)"
PRECACHE=$(cd "$OUT" && find . -type f ! -name '*.jsx' | sed 's|^\./|/|' | sort | sed 's|.*|  "&",|')
cat > "$OUT/sw.js" << SWEOF
const CACHE = 'health-${VERSION}';
const PRECACHE = [
  '/', '/nutricion/', '/metricas/',
${PRECACHE}
];
SWEOF
cat >> "$OUT/sw.js" << 'SWEOF'

// Cloudflare Pages redirige /x.html -> /x. Una respuesta "redirigida" guardada no
// sirve para navegar (el navegador la rechaza), asi que se guarda una copia limpia.
async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(PRECACHE.map(async u => {
    try {
      const r = await fetch(u, { cache: 'no-cache' });
      if (!r.ok) return;
      const body = await r.blob();
      await cache.put(u, new Response(body, { headers: { 'Content-Type': r.headers.get('Content-Type') || '' } }));
    } catch {}
  }));
}
self.addEventListener('install', e => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // APIs: siempre red
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then(r => {
      if (r.ok && !r.redirected && r.type === 'basic') cache.put(req, r.clone());
      return r;
    });
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('/index.html') : null);
    if (!cached) return net;
    return Promise.race([net, new Promise(res => setTimeout(() => res(cached), 3000))]).catch(() => cached);
  })());
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Health', {
    body: d.body || 'Tu rutina de hoy te espera',
    tag: d.tag || 'health',
    icon: '/icons/health-192.png',
    badge: '/icons/health-192.png',
    data: { url: d.url || '/#rutina' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#rutina', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(c => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus(); return w.navigate(url); }
    return clients.openWindow(url);
  })());
});
SWEOF

cat > "$OUT/_headers" << 'HEADERS'
/sw.js
  Cache-Control: no-store

/manifest.json
  Content-Type: application/manifest+json
  Cache-Control: no-cache

/*.html
  Cache-Control: no-cache

/*.js
  Cache-Control: no-cache

/*.css
  Cache-Control: no-cache
HEADERS

echo "health-pwa/ built OK"
