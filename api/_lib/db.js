import postgres from 'postgres';

// La base es Supabase y se exige explicitamente. Antes esto caia en cascada a
// DATABASE_URL, POSTGRES_URL y cualquier *_URL que oliera a postgres, asi que
// si SUPABASE_DB_URL faltaba la app arrancaba contra la Neon vieja (congelada
// desde la migracion) sin un solo error: login contra usuarios de hace meses y
// escrituras a una base muerta. Mejor no arrancar que servir datos de otra base.
function dbUrl() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error(
      'Falta SUPABASE_DB_URL. No se usa ningun fallback a proposito: ' +
      'arrancar contra otra base serviria datos incorrectos en silencio.',
    );
  }
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
// timeouts generalizados post-migracion (el driver anterior iba por HTTP y no
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
      const e = new Error('DB sin respuesta en 10s (conexión reciclada, reintenta)');
      e.recycled = true;
      reject(e);
    }, 10000);
    q.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

// Errores de conexion muerta: el pooler cerro el socket mientras Vercel tenia la
// instancia congelada; el primer query sobre ese socket lanza CONNECTION_DESTROYED.
function isConnErr(e) {
  if (e && e.recycled) return true;
  const s = String((e && (e.message || e.code)) || e);
  return /CONNECTION_DESTROYED|CONNECTION_CLOSED|CONNECTION_ENDED|ECONNRESET|EPIPE|write after end|Connection terminated|not queryable|socket hang up/i.test(s);
}

// Reintento unico: descarta el cliente muerto y reconecta de cero. Evita que un
// socket cerrado por el pooler tumbe una request entera con "CONNECTION_DESTROYED".
export async function sql(...args) {
  try {
    const c = live();
    return await guarded(c, c(...args));
  } catch (e) {
    if (!isConnErr(e)) throw e;
    if (client) { client.end({ timeout: 0 }).catch(() => {}); client = null; }
    const c2 = live();
    return await guarded(c2, c2(...args));
  }
}

let schemaReady = false;
// La sonda de ensureSchema salta todos los DDL si el schema ya existe, asi que
// una columna nueva nunca llegaria a una base ya creada. Esto la asegura aparte,
// memorizado para que sea un solo round trip por instancia.
let authColsReady = false;
export async function ensureAuthColumns() {
  if (authColsReady) return;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from BIGINT NOT NULL DEFAULT 0`;
  authColsReady = true;
}

export async function ensureSchema() {
  if (schemaReady) return;
  // Sonda barata (1 round trip): p2p_rate es lo ULTIMO que crea este bloque; si ya
  // existe, el schema esta completo y se saltan los ~20 DDLs secuenciales que
  // hacian eterno cada cold start. Si se agrega un DDL nuevo abajo, mover la sonda
  // al objeto mas nuevo (o borrarla temporalmente para que el DDL corra).
  const probe = await sql`SELECT to_regclass('p2p.market_snapshots') AS t`.catch(() => []);
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
  // Marca de revocacion: los JWT con iat anterior dejan de valer
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from BIGINT NOT NULL DEFAULT 0`;
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
  // Cantidad USDT restante del anuncio (surplusAmount), la trae gratis cada tick de reprice — la usa el P&L.
  await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS ad_amount NUMERIC`;
  // Anuncio escondido del listado publico por Binance (exceso de ordenes). Sigue activo
  // y repreciando; ad_seen_at evita falsos positivos si nunca llegamos a verlo en el libro.
  await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS ad_hidden BOOLEAN`;
  await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS ad_seen_at TIMESTAMPTZ`;
  // Velas OHLC por hora, por metodo de pago: { pay: [{t,o,h,l,c}] }.
  // Suscripciones Web Push (varias por usuario: una por dispositivo/navegador).
  await sql`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sub JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Historial de ordenes P2P del usuario (lo alimenta maybeCheckOrders en bot-tick).
  // Base de las metricas de rotacion: volumen/dia, ordenes/dia, tiempo entre ordenes.
  await sql`CREATE TABLE IF NOT EXISTS orders (
    order_no TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    trade_type TEXT,
    amount NUMERIC,
    total NUMERIC,
    price NUMERIC,
    status TEXT,
    created_at TIMESTAMPTZ,
    seen_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Tasa USDT/VES publica (mediana top-10 merchants por metodo de pago), la
  // actualiza cada refresh del monitor y la lee el portfolio via /api/usdt-ves.
  await sql`CREATE TABLE IF NOT EXISTS p2p_rate (
    pay TEXT PRIMARY KEY,
    rate NUMERIC NOT NULL,
    n INTEGER,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Snapshots del mercado BDV (grabador para el indice de debilidad). Lo alimenta el
  // cliente en lote via /market-snapshot. Base para backtest de senales de caida.
  await sql`CREATE TABLE IF NOT EXISTS market_snapshots (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    may_best NUMERIC,
    may_avail5 NUMERIC,
    may_top JSONB,
    rec_best NUMERIC,
    rec_avail5 NUMERIC,
    verde_best NUMERIC,
    verde_eff NUMERIC,
    spread_net NUMERIC,
    commission NUMERIC
  )`;
  await sql`CREATE INDEX IF NOT EXISTS market_snapshots_user_ts ON market_snapshots (user_id, ts)`;
  schemaReady = true;
}
