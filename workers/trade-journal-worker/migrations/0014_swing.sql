-- Estrategia de cada operacion del terminal: 'vwap' (Bitget, intradia) o
-- 'swing' (Binance, USDT-M y COIN-M). Cada una tiene sus propias reglas.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE exec_trades ADD COLUMN strategy TEXT NOT NULL DEFAULT 'vwap';
UPDATE exec_trades SET strategy = 'swing' WHERE exchange = 'binance';
