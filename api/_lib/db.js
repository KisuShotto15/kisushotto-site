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
  schemaReady = true;
}
