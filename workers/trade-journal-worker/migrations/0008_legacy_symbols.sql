-- Marcar posiciones heredadas por simbolo, no por fecha: el createdTime que
-- devuelve Bybit es la primera vez que existio una posicion en ese simbolo,
-- no la apertura de la actual, asi que fecharlas da falsos positivos.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE journal_config ADD COLUMN legacy_symbols TEXT;
UPDATE journal_config SET legacy_symbols = 'ETHUSD' WHERE id = 'main';
