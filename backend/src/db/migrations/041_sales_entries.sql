-- 041_sales_entries.sql
-- Rep-entered sales transactions. This is the staging area that later
-- pushes to AutoCount as SOs / invoices — the push is intentionally
-- deferred (autocount_doc_no populates once the push lands), so for
-- now entries just sit here in their own lifecycle.
--
-- Field customisation reuses the existing UDF mechanism
-- (backend/src/routes/udf.ts). Admins add fields via the UDF UI with
-- table_name='sales_entries' and row_key=<entry.id>. The form is
-- rendered dynamically from those field definitions, so there's no
-- second schema-config table here.

CREATE TABLE IF NOT EXISTS sales_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Optional project link. Walk-in sales not tied to an event are
  -- perfectly valid; project-tied sales inherit the project's ACL so
  -- scoped reps only see sales for their PIC's projects.
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  customer_name    TEXT NOT NULL,
  customer_code    TEXT,                           -- AutoCount customer code
  amount           REAL NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'MYR',
  occurred_at      TEXT NOT NULL,                  -- ISO yyyy-mm-dd
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft | submitted | pushed | void
  -- AutoCount push state. Populated once the push handler wires up.
  autocount_doc_no   TEXT,
  autocount_doc_type TEXT,                         -- 'SO' | 'INV'
  pushed_at          TEXT,
  push_error         TEXT,
  -- Ownership
  created_by       INTEGER NOT NULL,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  archived_at      TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sales_entries_by_user
  ON sales_entries(created_by, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_entries_by_project
  ON sales_entries(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_entries_status
  ON sales_entries(status);
CREATE INDEX IF NOT EXISTS idx_sales_entries_occurred
  ON sales_entries(occurred_at DESC);
