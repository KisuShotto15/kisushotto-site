-- Terminal de ejecucion con gestion de riesgo (Binance + Bitget).
-- Aplicar: npx wrangler d1 migrations apply trade-journal-db --remote

-- Cuentas conectadas. secret y passphrase van cifrados (AES-GCM, KEYS_SECRET).
-- dry_run = 1: el terminal calcula todo pero no envia ordenes ni corrige nada.
CREATE TABLE IF NOT EXISTS exec_accounts (
  exchange       TEXT    PRIMARY KEY,
  env            TEXT    NOT NULL DEFAULT 'live',
  mode           TEXT,
  api_key_enc    TEXT    NOT NULL,
  secret_enc     TEXT    NOT NULL,
  passphrase_enc TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Reglas vigentes y cambios que aflojan, en espera de 24h
CREATE TABLE IF NOT EXISTS risk_rules (
  id         TEXT    PRIMARY KEY,
  rules      TEXT    NOT NULL,
  pending    TEXT,
  pending_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Estado del dia: capital al abrir el dia/semana (NY) y bloqueos
CREATE TABLE IF NOT EXISTS risk_state (
  id                 TEXT    PRIMARY KEY,
  day                TEXT,
  day_start_equity   REAL,
  week               TEXT,
  week_start_equity  REAL,
  equity_now         REAL,
  equity_at          INTEGER,
  lock_until         INTEGER,
  lock_reason        TEXT,
  news_confirmed_day TEXT,
  guardian_at        INTEGER,
  guardian_error     TEXT
);

-- Libro de operaciones del terminal. Es la fuente de verdad de lo aprobado:
-- el guardian compara el exchange contra esto.
CREATE TABLE IF NOT EXISTS exec_trades (
  id           TEXT    PRIMARY KEY,
  exchange     TEXT    NOT NULL,
  market       TEXT    NOT NULL,
  symbol       TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  order_type   TEXT    NOT NULL DEFAULT 'market',
  status       TEXT    NOT NULL,
  qty          REAL,
  entry        REAL,
  stop         REAL,
  initial_stop REAL,
  tp           REAL,
  risk_usd     REAL,
  risk_pct     REAL,
  equity_base  REAL,
  leverage     INTEGER,
  rr           REAL,
  checklist    TEXT,
  setup        TEXT,
  notes        TEXT,
  emotion      TEXT,
  signal       TEXT,
  client_id    TEXT,
  order_id     TEXT,
  external     INTEGER NOT NULL DEFAULT 0,
  opened_at    INTEGER NOT NULL,
  closed_at    INTEGER,
  exit_price   REAL,
  pnl          REAL,
  r            REAL,
  close_reason TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_trades_status ON exec_trades(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_trades_opened ON exec_trades(opened_at DESC);

-- Bitacora: cada orden, rechazo, correccion del guardian y cambio de reglas
CREATE TABLE IF NOT EXISTS risk_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  severity TEXT    NOT NULL DEFAULT 'info',
  message  TEXT    NOT NULL,
  data     TEXT
);
CREATE INDEX IF NOT EXISTS idx_risk_events_ts ON risk_events(ts DESC);

-- Calendario economico: solo eventos de impacto alto en USD (fecha NY)
CREATE TABLE IF NOT EXISTS news_events (
  date   TEXT NOT NULL,
  title  TEXT NOT NULL,
  time   TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ff',
  PRIMARY KEY (date, title, time)
);

CREATE TABLE IF NOT EXISTS news_meta (
  id           TEXT PRIMARY KEY,
  covered_from TEXT,
  covered_to   TEXT,
  fetched_at   INTEGER,
  error        TEXT
);
