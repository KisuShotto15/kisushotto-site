#!/usr/bin/env bash
# Builds a self-contained notes-pwa/ directory for deployment to notes.kisushotto.com
set -e

OUT="notes-pwa"

mkdir -p "$OUT/icons" "$OUT/images"

# App files
cp notes/index.html  "$OUT/index.html"
cp notes/style.css   "$OUT/style.css"
cp notes/main.js     "$OUT/main.js"
cp notes/api.js      "$OUT/api.js"
cp notes/auth.js     "$OUT/auth.js"
cp notes/idb.js      "$OUT/idb.js"
cp notes/sync.js     "$OUT/sync.js"
cp notes/push.js     "$OUT/push.js"
cp notes/recorder.js "$OUT/recorder.js"

# Adjust manifest path in index.html (subdominio uses /manifest.json at root)
sed -i 's|href="/manifests/notes.json"|href="/manifest.json"|g' "$OUT/index.html"

# Manifest at root, with start_url/scope rewritten to "/"
cp public/manifests/notes.json "$OUT/manifest.json"
sed -i 's|"start_url": "/notes/"|"start_url": "/"|; s|"scope": "/notes/"|"scope": "/"|' "$OUT/manifest.json"

# Service worker
cp public/sw.js "$OUT/sw.js"

# Icons
cp public/icons/notes-192.png "$OUT/icons/notes-192.png"
cp public/icons/notes-512.png "$OUT/icons/notes-512.png"

# Favicon + logo SVG
cp public/images/notes-favicon.svg "$OUT/images/notes-favicon.svg"
cp public/images/notes-logo.svg    "$OUT/images/notes-logo.svg"
cp public/images/notes-icon.svg    "$OUT/images/notes-icon.svg"

# Cache headers (not regenerated each build, only if missing)
if [ ! -f "$OUT/_headers" ]; then
  cat > "$OUT/_headers" << 'HEADERS'
/sw.js
  Cache-Control: public, max-age=0, must-revalidate

/manifest.json
  Cache-Control: public, max-age=86400
HEADERS
fi

echo "notes-pwa/ built OK"
