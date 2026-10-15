-- D1 / test-tree twin of migrations-pg/20261014T1304_pos_admin_masters.sql.
-- The prod tree is Postgres; this SQLite copy exists so the generated test
-- schema carries the Houzs POS Admin masters. SQLite types; no backfill.
CREATE TABLE IF NOT EXISTS pos_settings (
  company_id   INTEGER NOT NULL,
  "group"      TEXT NOT NULL,
  value        TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by   INTEGER,
  PRIMARY KEY (company_id, "group")
);

CREATE TABLE IF NOT EXISTS pos_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id            INTEGER NOT NULL,
  product_id            TEXT NOT NULL,
  item_code             TEXT NOT NULL,
  name                  TEXT NOT NULL,
  uom                   TEXT NOT NULL DEFAULT 'UNIT',
  price_sen             INTEGER NOT NULL DEFAULT 0,
  cost_sen              INTEGER,
  preset_discount_type  TEXT,
  preset_discount_value REAL,
  foc_allowed           INTEGER NOT NULL DEFAULT 0,
  max_manual_disc_pct   REAL,
  stock_source_warehouse_id TEXT,
  receipt_name          TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_items_product ON pos_items (company_id, product_id);
CREATE INDEX IF NOT EXISTS idx_pos_items_company_code ON pos_items (company_id, item_code);

CREATE TABLE IF NOT EXISTS pos_item_barcodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL,
  pos_item_id   INTEGER NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  barcode       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_item_barcodes ON pos_item_barcodes (company_id, barcode);

CREATE TABLE IF NOT EXISTS pos_generated_barcodes (
  company_id    INTEGER NOT NULL,
  product_id    TEXT NOT NULL,
  barcode       TEXT NOT NULL UNIQUE,
  generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  generated_by  INTEGER,
  PRIMARY KEY (company_id, product_id)
);

CREATE TABLE IF NOT EXISTS pos_cashiers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  phone              TEXT,
  pin_hash           TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'PARTTIME',
  max_discount_pct   REAL NOT NULL DEFAULT 0,
  working_hours_note TEXT,
  bank_note          TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_cashiers_code ON pos_cashiers (company_id, code);

CREATE TABLE IF NOT EXISTS pos_terminals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL,
  code               TEXT NOT NULL,
  device_name        TEXT,
  platform           TEXT,
  project_id         INTEGER,
  printer            TEXT,
  prepared_at        TEXT,
  last_seen_at       TEXT,
  last_sync_at       TEXT,
  pending_count      INTEGER NOT NULL DEFAULT 0,
  pending_amount_sen INTEGER NOT NULL DEFAULT 0,
  receipt_counter    INTEGER NOT NULL DEFAULT 0,
  app_version        TEXT,
  status             TEXT NOT NULL DEFAULT 'NEW',
  active             INTEGER NOT NULL DEFAULT 1,
  token_hash         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_terminals_code ON pos_terminals (company_id, code);

CREATE TABLE IF NOT EXISTS pos_event_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL,
  project_id       INTEGER NOT NULL,
  catalog_scope    TEXT NOT NULL DEFAULT 'ALL',
  stock_source_warehouse_id TEXT,
  sst_default      INTEGER NOT NULL DEFAULT 0,
  receipt_header   TEXT,
  catalog_version  INTEGER NOT NULL DEFAULT 1,
  pushed_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_event_links_project ON pos_event_links (company_id, project_id);

CREATE TABLE IF NOT EXISTS pos_event_cashiers (
  link_id     INTEGER NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  cashier_id  INTEGER NOT NULL REFERENCES pos_cashiers (id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, cashier_id)
);

CREATE TABLE IF NOT EXISTS pos_event_items (
  link_id      INTEGER NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  pos_item_id  INTEGER NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, pos_item_id)
);

CREATE TABLE IF NOT EXISTS pos_event_prices (
  link_id      INTEGER NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  pos_item_id  INTEGER NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  price_sen    INTEGER NOT NULL,
  PRIMARY KEY (link_id, pos_item_id)
);
