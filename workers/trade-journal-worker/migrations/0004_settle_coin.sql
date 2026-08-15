-- Los contratos inverse liquidan en su moneda base (ETHUSD paga en ETH), asi
-- que el PnL no realizado no se puede sumar con el de los pares en USDT.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE live_positions ADD COLUMN settle_coin TEXT;
