-- El drawdown en % necesita un capital contra el que medir. Sin esto se
-- calculaba contra el pico del PnL acumulado (que empieza en 0) y daba
-- valores imposibles como 118%.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

CREATE TABLE IF NOT EXISTS account_balance (
  id             TEXT    PRIMARY KEY,
  total_equity   REAL,
  wallet_balance REAL,
  coin           TEXT    NOT NULL DEFAULT 'USDT',
  updated_at     INTEGER NOT NULL
);
