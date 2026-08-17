-- Distinguir el stop que se capturo solo del exchange del que se escribio a
-- mano, para que la UI no pida rellenar algo que ya viene automatico.
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

ALTER TABLE trades ADD COLUMN stop_source TEXT;
