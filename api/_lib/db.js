import { neon } from '@neondatabase/serverless';

// Acepta cualquier nombre que use la integracion de Neon/Vercel (con o sin prefijo).
function dbUrl() {
  const e = process.env;
  const url = e.DATABASE_URL || e.POSTGRES_URL || e.STORAGE_URL || e.STORAGE_DATABASE_URL ||
    e.STORAGE_POSTGRES_URL || e.POSTGRES_PRISMA_URL ||
    (Object.keys(e).filter(k => /_URL$/.test(k) && /postgres|neon|database/i.test(e[k]))
      .map(k => e[k])[0]);
  if (!url) throw new Error('No se encontro la connection string de Postgres en env');
  return url;
}

export const sql = neon(dbUrl());

let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
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
  schemaReady = true;
}
