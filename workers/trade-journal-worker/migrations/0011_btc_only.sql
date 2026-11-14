-- La estrategia VWAP a 51x se opera solo en Bitcoin. Restringir simbolos es
-- endurecer una regla, asi que aplica de inmediato.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

UPDATE risk_rules SET rules = json_set(rules, '$.symbols', json('["BTCUSDT"]')), updated_at = unixepoch()
WHERE id = 'main';
