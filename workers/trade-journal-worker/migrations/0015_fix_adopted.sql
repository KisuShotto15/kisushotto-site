-- Correccion tras el recorte indebido del short BTCUSDT de Bitget (14-nov):
-- el riesgo se calculaba con valor absoluto y un stop del lado de la ganancia
-- contaba como riesgo. Las posiciones abiertas antes del modo real quedan
-- marcadas como previas (external = 2): el guardian avisa, no las recorta.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

UPDATE exec_trades SET external = 2
WHERE status = 'open' AND external = 1;

UPDATE exec_trades SET risk_usd = 0
WHERE status = 'open' AND stop IS NOT NULL AND (
  (side = 'short' AND stop <= entry) OR (side = 'long' AND stop >= entry)
);
