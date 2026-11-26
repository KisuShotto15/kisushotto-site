# Relay de salida (Vercel, Cloud Run o Deno)

Binance y Bitget bloquean las IP de Cloudflare, donde vive el guardián del trade
journal. Este relay reenvía sus consultas firmadas. Es el mismo código que
`api/exchange-relay.js` en Vercel, pero en Cloud Run no gasta el Fluid Active CPU
de Vercel y su capa gratuita cubre de sobra este uso.

## 1. Proyecto en Google Cloud (una sola vez)

1. Entra a https://console.cloud.google.com con tu cuenta de Google.
2. Arriba, en el selector de proyectos → **Proyecto nuevo** → nombre `kisushotto-relay` → **Crear**.
3. Menú ☰ → **Facturación** → vincula una cuenta de facturación al proyecto (pide tarjeta;
   con este uso no cobra).
4. Recomendado: **Facturación → Presupuestos y alertas → Crear presupuesto** de 1 USD con
   alertas al 50 % y 100 %, para que te avise si algo cambia.

## 2. Desplegar el relay (desde Cloud Shell, en el navegador)

Abre **Cloud Shell** (icono `>_` arriba a la derecha) y pega, uno a la vez:

```bash
gcloud config set project kisushotto-relay
```

(Si Google le agregó números al ID del proyecto, usa el ID que muestra el selector.)

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

```bash
git clone --depth 1 https://github.com/KisuShotto15/kisushotto-site.git && cd kisushotto-site/relay
```

```bash
SECRET=$(openssl rand -hex 32); echo "Guarda esta clave: $SECRET"
```

```bash
gcloud run deploy kisushotto-relay --source . --region europe-west1 --allow-unauthenticated --set-env-vars RELAY_SECRET=$SECRET --min-instances 0 --max-instances 2
```

Si pregunta si crear un repositorio de Artifact Registry, responde `Y`. Al terminar
muestra una **Service URL** como `https://kisushotto-relay-xxxxx.europe-west1.run.app`.

Prueba que responde:

```bash
curl "$(gcloud run services describe kisushotto-relay --region europe-west1 --format 'value(status.url)')"
```

Debe mostrar `{"ok":true,"relay":"kisushotto"}`.

## 3. Conectar el guardián (Cloudflare)

1. https://dash.cloudflare.com → **Workers & Pages** → `trade-journal-worker` →
   **Settings** → **Variables and Secrets** → **Add**:
   - `RELAY_URL` (tipo **Text**): la Service URL + `/api/exchange-relay`
   - `RELAY_SECRET` (tipo **Secret**): la clave que guardaste en el paso 2
2. **Deploy**.

Desde ese momento el guardián y el terminal salen por Cloud Run. Para volver a
Vercel basta con borrar `RELAY_SECRET`.

La clave nunca debe pegarse en un chat: solo en Cloud Shell y en Cloudflare.
