-- D1 / test-tree twin of migrations-pg/20261014T1147_pos_cash_and_carry_sales.sql.
-- The prod tree is Postgres; this SQLite copy exists so the generated test
-- schema carries the Houzs POS tables the project page's POS Sales list reads.
-- SQLite types; no backfill (tests start empty).
INSERT INTO project_event_types (slug, name, sort_order, default_template_id, active)
SELECT 'cash_carry', 'Cash & Carry', COALESCE((SELECT MAX(sort_order) FROM project_event_types), 0) + 1, NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM project_event_types WHERE slug = 'cash_carry');

CREATE TABLE IF NOT EXISTS pos_sales (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                TEXT NOT NULL UNIQUE,
  company_id          INTEGER NOT NULL,
  project_id          INTEGER NOT NULL,
  terminal_code       TEXT NOT NULL,
  receipt_no          TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'SALE',
  ref_sale_uuid       TEXT,
  cashier_id          INTEGER,
  cashier_name        TEXT,
  salesman_id         INTEGER,
  salesman_name       TEXT,
  customer_name       TEXT,
  customer_phone      TEXT,
  sold_at             TEXT NOT NULL,
  subtotal_sen        INTEGER NOT NULL DEFAULT 0,
  item_discount_sen   INTEGER NOT NULL DEFAULT 0,
  bill_discount_sen   INTEGER NOT NULL DEFAULT 0,
  sst_applied         INTEGER NOT NULL DEFAULT 0,
  sst_rate            REAL NOT NULL DEFAULT 0,
  sst_amount_sen      INTEGER NOT NULL DEFAULT 0,
  rounding_sen        INTEGER NOT NULL DEFAULT 0,
  total_sen           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'PAID',
  void_reason         TEXT,
  void_by             TEXT,
  voided_at           TEXT,
  is_test             INTEGER NOT NULL DEFAULT 0,
  source              TEXT NOT NULL DEFAULT 'NORMAL',
  local_seq           INTEGER,
  synced_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_receipt ON pos_sales (company_id, terminal_code, receipt_no);
CREATE INDEX IF NOT EXISTS idx_pos_sales_project_sold ON pos_sales (project_id, sold_at);

CREATE TABLE IF NOT EXISTS pos_sale_lines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id             INTEGER NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,
  line_no             INTEGER NOT NULL,
  item_id             INTEGER,
  item_code           TEXT NOT NULL,
  description         TEXT NOT NULL,
  uom                 TEXT NOT NULL DEFAULT 'UNIT',
  qty                 REAL NOT NULL,
  unit_price_sen      INTEGER NOT NULL,
  original_price_sen  INTEGER,
  override_by         TEXT,
  override_reason     TEXT,
  discount_source     TEXT,
  discount_type       TEXT,
  discount_value      REAL,
  discount_amount_sen INTEGER NOT NULL DEFAULT 0,
  is_foc              INTEGER NOT NULL DEFAULT 0,
  amount_sen          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sale_lines_no ON pos_sale_lines (sale_id, line_no);

CREATE TABLE IF NOT EXISTS pos_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id             INTEGER NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,
  method              TEXT NOT NULL,
  amount_sen          INTEGER NOT NULL,
  reference           TEXT,
  last4               TEXT,
  tendered_sen        INTEGER,
  change_sen          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pos_payments_sale ON pos_payments (sale_id);

CREATE TABLE IF NOT EXISTS pos_audit (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL,
  entity              TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  field               TEXT NOT NULL,
  from_value          TEXT,
  to_value            TEXT,
  by_user_id          INTEGER,
  by_name             TEXT,
  at                  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_audit_entity ON pos_audit (entity, entity_id);
