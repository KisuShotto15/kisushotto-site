-- Plan pre-trade: se llena mientras la posicion sigue abierta y se pega al
-- trade cuando el sync lo trae ya cerrado.
-- Aplicar con: npx wrangler d1 execute trade-journal-db --remote --file=migrations/0002_trade_plans.sql

CREATE TABLE IF NOT EXISTS trade_plans (
  symbol       TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  opened_at    INTEGER NOT NULL,
  setup_tag    TEXT,
  strategy_tag TEXT,
  rule_score   INTEGER,
  checklist    TEXT,
  notes        TEXT,
  applied      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (symbol, side, opened_at)
);

CREATE INDEX IF NOT EXISTS idx_plans_pending ON trade_plans(applied, symbol, side);
