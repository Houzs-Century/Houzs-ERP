-- D1 test mirror of migrations-pg/0282_ac_snapshot_tables.sql.
CREATE TABLE IF NOT EXISTS ac_snapshot_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  stored INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS ac_snapshot_runs_kind_started_idx ON ac_snapshot_runs (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS ac_snapshot_sales_orders (
  doc_no TEXT PRIMARY KEY,
  doc_date TEXT,
  ref TEXT,
  branding TEXT,
  debtor_name TEXT,
  sales_location TEXT,
  sales_agent TEXT,
  venue TEXT,
  local_total REAL,
  balance REAL,
  remark2 TEXT,
  transfer_to TEXT,
  po_doc_no TEXT,
  last_modified TEXT,
  region_route TEXT,
  raw TEXT,
  snapshot_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ac_snapshot_so_region_idx ON ac_snapshot_sales_orders (region_route);
CREATE INDEX IF NOT EXISTS ac_snapshot_so_doc_date_idx ON ac_snapshot_sales_orders (doc_date);

CREATE TABLE IF NOT EXISTS ac_snapshot_purchase_orders (
  doc_no TEXT PRIMARY KEY,
  doc_date TEXT,
  ref TEXT,
  so_doc_no TEXT,
  creditor_code TEXT,
  creditor_name TEXT,
  purchase_location TEXT,
  doc_status TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  local_ex_tax REAL,
  local_net_total REAL,
  final_total REAL,
  currency_code TEXT,
  last_modified TEXT,
  raw TEXT,
  snapshot_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ac_snapshot_po_doc_date_idx ON ac_snapshot_purchase_orders (doc_date);
CREATE INDEX IF NOT EXISTS ac_snapshot_po_cancelled_idx ON ac_snapshot_purchase_orders (cancelled);
