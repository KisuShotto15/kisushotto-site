CREATE TABLE IF NOT EXISTS trades (
  id           TEXT    PRIMARY KEY,
  symbol       TEXT    NOT NULL,
  category     TEXT    NOT NULL DEFAULT 'linear',
  side         TEXT    NOT NULL CHECK(side IN ('long','short','buy','sell')),
  entry_price  REAL    NOT NULL,
  exit_price   REAL,
  size         REAL    NOT NULL,
  pnl          REAL,
  fees         REAL    NOT NULL DEFAULT 0,
  entry_time   INTEGER NOT NULL,
  exit_time    INTEGER,
  strategy_tag TEXT,
  setup_tag    TEXT,
  session      TEXT    CHECK(session IN ('asia','london','ny','other')),
  exec_type    TEXT    NOT NULL DEFAULT 'manual',
  notes        TEXT,
  emotion      TEXT,
  rule_score   INTEGER,
  status       TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  exchange     TEXT    NOT NULL DEFAULT 'bybit',
  exchange_id  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS strategies (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS setups (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS insights (
  id           TEXT    PRIMARY KEY,
  type         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  severity     TEXT    NOT NULL DEFAULT 'info',
  data         TEXT,
  generated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_trades_time     ON trades(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol   ON trades(symbol, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status   ON trades(status, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_setup    ON trades(setup_tag, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_session  ON trades(session, entry_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_exchange
  ON trades(exchange, exchange_id)
  WHERE exchange_id IS NOT NULL;
