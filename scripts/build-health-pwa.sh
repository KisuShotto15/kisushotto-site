#!/usr/bin/env bash
# Builds a self-contained health-pwa/ directory for deployment to health.kisushotto.com
# Layout: / (shell con pestanas), /rutina.html, /nutrition/, /body-metrics/
# El shell usa rutas relativas (rutina.html, ../nutrition/, ../body-metrics/) que
# funcionan igual aqui y en kisushotto.com/health/.
set -e

OUT="health-pwa"
rm -rf "$OUT"
mkdir -p "$OUT/icons" "$OUT/images" "$OUT/manifests"

# Shell + rutina
cp health/index.html  "$OUT/index.html"
cp health/rutina.html "$OUT/rutina.html"
# En el subdominio el manifest vive en la raiz
sed -i 's|href="/manifests/health.json"|href="/manifest.json"|g' "$OUT/index.html"

# Apps embebidas (archivos fuente tal cual: solo usan imports relativos y CDN)
cp -r nutrition    "$OUT/nutrition"
cp -r body-metrics "$OUT/body-metrics"

# Manifest raiz con start_url/scope en "/"
cp public/manifests/health.json "$OUT/manifest.json"
sed -i 's|"start_url": "/health/"|"start_url": "/"|; s|"scope": "/health/"|"scope": "/"|' "$OUT/manifest.json"
cp public/manifests/nutrition.json public/manifests/body-metrics.json "$OUT/manifests/"

# Iconos e imagenes que usan el shell y las apps embebidas
cp public/icons/health-192.png public/icons/health-512.png \
   public/icons/icon-192x192.png public/icons/icon-512x512.png "$OUT/icons/"
cp public/images/health-icon.svg public/images/health-favicon.svg \
   public/images/nutrition-favicon.svg public/images/nutrition-icon.svg \
   public/images/bm-favicon.svg public/images/bm-icon.svg "$OUT/images/"

# Service worker minimo (instalable como PWA, sin cache: siempre la ultima version)
cat > "$OUT/sw.js" << 'SWEOF'
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
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
