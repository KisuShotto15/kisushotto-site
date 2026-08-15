-- R-multiple + screenshots propios + snapshots de posiciones abiertas.
-- Aplicar con: npx wrangler d1 execute trade-journal-db --remote --file=migrations/0001_r_multiple.sql

ALTER TABLE trades ADD COLUMN stop_price  REAL;
ALTER TABLE trades ADD COLUMN risk_usd    REAL;
ALTER TABLE trades ADD COLUMN screenshots TEXT;

-- La UI guardaba el JSON de screenshots dentro de strategy_tag, lo que dejaba
-- el analisis por estrategia inservible. Se mueve a su propia columna.
UPDATE trades SET screenshots = strategy_tag, strategy_tag = NULL
  WHERE strategy_tag LIKE '[%';

-- Bybit no devuelve el stop loss de un trade ya cerrado. Guardamos el stop de
-- las posiciones abiertas mientras viven para poder calcular la R al cerrarse.
CREATE TABLE IF NOT EXISTS position_snapshots (
  symbol      TEXT    NOT NULL,
  side        TEXT    NOT NULL,
  opened_at   INTEGER NOT NULL,
  entry_price REAL,
  stop_price  REAL,
  take_profit REAL,
  size        REAL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (symbol, side, opened_at)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_seen ON position_snapshots(symbol, side, seen_at DESC);
