#!/usr/bin/env bash
# Builds a self-contained health-pwa/ directory for deployment to health.kisushotto.com
set -e

OUT="health-pwa"
rm -rf "$OUT"
mkdir -p "$OUT/icons" "$OUT/images"

# Toda la app vive en health/: shell, Hoy, Rutina, Nutricion y Metricas.
# Las rutas son relativas, asi que funciona igual aqui y en kisushotto.com/health/.
cp health/index.html health/hoy.html health/rutina.html health/auth.js "$OUT/"
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

# Service worker: instalable como PWA, sin cache (siempre la ultima version) y
# con el recordatorio diario por push (lo envia habits-worker, ruta /health/*)
cat > "$OUT/sw.js" << 'SWEOF'
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
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
