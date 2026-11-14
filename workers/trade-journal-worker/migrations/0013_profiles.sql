-- Separar la estrategia VWAP (Bitget) de las cuentas de swing (Binance).
-- equity_scope: que cuentas forman el capital de la estrategia; si cambia, la
-- base del dia y la semana se vuelve a tomar para no dar perdidas falsas.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE risk_state ADD COLUMN equity_scope TEXT;
