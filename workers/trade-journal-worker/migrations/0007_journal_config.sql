-- Punto de partida declarado. El capital no se puede derivar del equity actual
-- porque los depositos y el capital inmovilizado (ETHUSD atrapado) lo falsean.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

CREATE TABLE IF NOT EXISTS journal_config (
  id            TEXT    PRIMARY KEY,
  start_capital REAL,
  start_date    INTEGER,
  updated_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO journal_config (id, start_capital, start_date, updated_at)
VALUES ('main', 1000, strftime('%s','2026-08-14'), strftime('%s','now'));
