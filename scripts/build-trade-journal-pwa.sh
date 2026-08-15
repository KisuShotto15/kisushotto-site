#!/usr/bin/env bash
# Construye trade-journal-pwa/ para desplegar en trades.kisushotto.com
# El dashboard queda en la raiz del subdominio, no en /trade-journal/.
set -e

OUT="trade-journal-pwa"
BUILD_ID="$(date +%s)"

# Vite emite dist/trade-journal/*.html con assets en dist/assets/
npm run build

rm -rf "$OUT"
mkdir -p "$OUT"

# Paginas a la raiz: los enlaces internos ya son relativos (./trades.html)
cp dist/trade-journal/*.html "$OUT/"

# Los HTML referencian /assets/ y /images/ absolutos, asi que se copian tal cual
cp -r dist/assets "$OUT/assets"
cp -r dist/images "$OUT/images"

# El manifest se sirve en la raiz del subdominio
sed -i 's|href="/manifests/trade-journal.json"|href="/manifest.json"|g' "$OUT"/*.html

# El boton "Hub" apunta a / y en el subdominio eso seria volver al dashboard
sed -i 's|href="/" class="left-nav-back"|href="https://kisushotto.com/" class="left-nav-back"|g' "$OUT"/*.html

# Manifest con scope en la raiz
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('public/manifests/trade-journal.json','utf8'));
m.start_url = '/';
m.scope = '/';
fs.writeFileSync('$OUT/manifest.json', JSON.stringify(m, null, 2));
"

# Los assets llevan hash en el nombre, el HTML no debe cachearse
cat > "$OUT/_headers" << 'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/manifest.json
  Cache-Control: public, max-age=86400

/*.html
  Cache-Control: no-cache
HEADERS

# Sin _redirects a proposito: Pages ya sirve /trades desde trades.html y
# redirige /trades.html -> /trades. Agregar reglas propias crea un bucle.
# Los enlaces internos apuntan directo a la URL limpia para evitar el salto.
sed -i -E 's#href="\./(trades|analytics|insights)\.html"#href="./\1"#g' "$OUT"/*.html
sed -i -E 's#href="\./index\.html"#href="./"#g' "$OUT"/*.html

echo "$OUT/ built OK (build ${BUILD_ID})"
