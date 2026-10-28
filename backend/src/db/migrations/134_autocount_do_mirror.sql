-- 134_autocount_do_mirror.sql — D1/SQLite twin of migrations-pg/0215.
-- Test-mirror only (prod runs Postgres): the AutoCount Delivery Order
-- header mirror behind the ASSR list's DO No column. Keep the shape in
-- lockstep with 0215_autocount_do_mirror.sql.
CREATE TABLE IF NOT EXISTS autocount_delivery_orders (
  doc_no        TEXT PRIMARY KEY,
  doc_date      TEXT,
  ref           TEXT,
  debtor_name   TEXT,
  sales_agent   TEXT,
  total         REAL,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  so_doc_nos    TEXT,
  last_modified TEXT,
  synced_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ac_do_ref
  ON autocount_delivery_orders (LOWER(ref));
