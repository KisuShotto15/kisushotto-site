-- Senal al entrar (sigma VWAP, RSI 6, estocastico) guardada con cada operacion
-- del terminal, copia de las posiciones para el dashboard y marca del ultimo
-- sync del historial de posiciones cerradas.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE trades     ADD COLUMN signal         TEXT;
ALTER TABLE risk_state ADD COLUMN positions_json TEXT;
ALTER TABLE risk_state ADD COLUMN history_at     INTEGER;
