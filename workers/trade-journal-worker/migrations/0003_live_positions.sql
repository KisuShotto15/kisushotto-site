-- Espejo de las posiciones abiertas, refrescado por el cron cada minuto.
-- Existe porque el fetch a Bybit desde el colo del usuario puede dar 403:
-- CloudFront bloquea por pais y el worker corre cerca de quien pide.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

CREATE TABLE IF NOT EXISTS live_positions (
  symbol         TEXT    NOT NULL,
  side           TEXT    NOT NULL,
  category       TEXT,
  size           REAL,
  entry_price    REAL,
  mark_price     REAL,
  unrealized_pnl REAL,
  roi_pct        REAL,
  leverage       REAL,
  position_value REAL,
  take_profit    REAL,
  stop_loss      REAL,
  liq_price      REAL,
  opened_at      INTEGER,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (symbol, side)
);
