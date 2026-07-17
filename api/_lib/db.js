import postgres from 'postgres';

// Acepta cualquier nombre que use la integracion de la DB en Vercel (con o sin prefijo).
function dbUrl() {
  const e = process.env;
  const url = e.SUPABASE_DB_URL || e.DATABASE_URL || e.POSTGRES_URL || e.STORAGE_URL || e.STORAGE_DATABASE_URL ||
    e.STORAGE_POSTGRES_URL || e.POSTGRES_PRISMA_URL ||
    (Object.keys(e).filter(k => /_URL$/.test(k) && /postgres|neon|supabase|database/i.test(e[k]))
      .map(k => e[k])[0]);
  if (!url) throw new Error('No se encontro la connection string de Postgres en env');
  return url;
}

// Supabase via Supavisor (pooler, puerto 6543, modo transaccion): prepare:false es
// obligatorio; max:1 e idle_timeout cortos porque cada invocacion serverless es efimera.
function mkClient() {
  return postgres(dbUrl(), {
    ssl: 'require',
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    // Los types van con OIDs explicitos: no hace falta el round trip de fetch_types al conectar.
    fetch_types: false,
    // Las tablas de la app viven en el schema p2p (el proyecto Supabase es compartido).
    connection: { search_path: 'p2p' },
    // El codigo envia jsonb como texto ya serializado (JSON.stringify(x) + ::jsonb).
    // El serializer json por defecto re-stringifica ese string y doble-codifica
    // (queda jsonb "string" en vez de array/objeto). OIDs: 114 = json, 3802 = jsonb.
    types: {
      json: {
        to: 114,
        from: [114, 3802],
        serialize: v => typeof v === 'string' ? v : JSON.stringify(v),
        parse: v => JSON.parse(v),
      },
    },
  });
}

// Vercel CONGELA la instancia entre invocaciones: los timers de idle_timeout no
// corren y el NAT descarta el TCP idle en silencio. Reusar esa conexion "viva"
// cuelga la query hasta la retransmision TCP (minutos) — era la causa de los
// timeouts generalizados post-migracion (el driver de Neon iba por HTTP y no
// mantenia TCP entre invocaciones). Si paso >60s sin uso, se descarta el cliente
// y se conecta de cero (idle_timeout 20s lo habria cerrado igual si corriera).
let client = null;
let lastUsed = 0;
function live() {
  const now = Date.now();
  if (client && now - lastUsed > 60000) {
    client.end({ timeout: 0 }).catch(() => {});
    client = null;
  }
  if (!client) client = mkClient();
  lastUsed = now;
  return client;
}

// Watchdog por query: si la conexion muere BAJO trafico continuo (pollers cada
// 10-15s), lastUsed se refresca siempre y live() nunca la recicla — todas las
// queries quedarian en cola detras de la muerta para siempre. A los 10s se
// descarta el cliente (la proxima llamada reconecta) y la query falla con un
// error claro en vez de colgar hasta que el HTTP del cliente aborte.
function guarded(c, q) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (client === c) client = null;
      c.end({ timeout: 0 }).catch(() => {});
      reject(new Error('DB sin respuesta en 10s (conexión reciclada, reintenta)'));
    }, 10000);
    q.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

export function sql(...args) {
  const c = live();
  return guarded(c, c(...args));
}

let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  // Sonda barata (1 round trip): p2p_rate es lo ULTIMO que crea este bloque; si ya
  // existe, el schema esta completo y se saltan los ~20 DDLs secuenciales que
  // hacian eterno cada cold start. Si se agrega un DDL nuevo abajo, mover la sonda
  // al objeto mas nuevo (o borrarla temporalmente para que el DDL corra).
  const probe = await sql`SELECT to_regclass('p2p.p2p_rate') AS t`.catch(() => []);
  if (probe[0] && probe[0].t) { schemaReady = true; return; }
  await sql`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS binance_creds (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enc_key TEXT NOT NULL, iv_key TEXT NOT NULL, tag_key TEXT NOT NULL,
    enc_secret TEXT NOT NULL, iv_secret TEXT NOT NULL, tag_secret TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // verified: default true para no bloquear usuarios pre-existentes; register inserta false explicito.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT true`;
  await sql`CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Preferencias del usuario (config monitor + bot + metodo de pago) para sincronizar dispositivos.
  await sql`CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Estado del bot por usuario (ejecucion server-side via /api/bot-tick).
  await sql`CREATE TABLE IF NOT EXISTS bot_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    config JSONB,
    ad_number TEXT,
    current_price NUMERIC,
    last_reprice TIMESTAMPTZ,
    last_tick TIMESTAMPTZ,
    status TEXT,
    log JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Monitor server-side (alertas Telegram 24/7 con silencio nocturno), via /api/bot-tick.
  await sql`CREATE TABLE IF NOT EXISTS monitor_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    config JSONB,
    price_hist JSONB,
    cooldowns JSONB,
    status TEXT,
    log JSONB,
    last_tick TIMESTAMPTZ,
    client_seen TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  // client_seen: latido de la app abierta. Si esta fresco, el servidor NO busca (evita duplicar).
  await sql`ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS client_seen TIMESTAMPTZ`;
  // hist24: serie de 24h (mejor mayorista) para el sparkline. last_summary: ultimo resumen diario enviado.
  await sql`ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS hist24 JSONB`;
  await sql`ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS last_summary TIMESTAMPTZ`;
  // hist_long: serie de 60 dias (1 punto/30min) para la pagina de historial grande.
  await sql`ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS hist_long JSONB`;
  // Ordenes ya vistas (para notificar ordenes nuevas server-side) + ultima revision.
  await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS known_orders JSONB`;
  await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS orders_checked_at TIMESTAMPTZ`;
  // Velas OHLC por hora, por metodo de pago: { pay: [{t,o,h,l,c}] }.
  await sql`ALTER TABLE monitor_state ADD COLUMN IF NOT EXISTS hist_ohlc JSONB`;
  // Suscripciones Web Push (varias por usuario: una por dispositivo/navegador).
  await sql`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sub JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Tasa USDT/VES publica (mediana top-10 merchants por metodo de pago), la
  // actualiza cada refresh del monitor y la lee el portfolio via /api/usdt-ves.
  await sql`CREATE TABLE IF NOT EXISTS p2p_rate (
    pay TEXT PRIMARY KEY,
    rate NUMERIC NOT NULL,
    n INTEGER,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  schemaReady = true;
}
