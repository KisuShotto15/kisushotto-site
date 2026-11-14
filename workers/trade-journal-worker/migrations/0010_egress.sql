-- Ultima prueba de salida del gateway: colo de Cloudflare y si Binance/Bitget
-- responden desde ahi. La escribe el guardian cada 30 min.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE risk_state ADD COLUMN egress    TEXT;
ALTER TABLE risk_state ADD COLUMN egress_at INTEGER;
