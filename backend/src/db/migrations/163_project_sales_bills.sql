-- D1 / test-tree twin of migrations-pg/20261014T1600_project_sales_bills.sql.
-- The prod tree is Postgres; this SQLite copy exists so the generated test
-- schema (tests/generated/test-schema-snapshot.sql) carries the table the
-- project page's sales report reads. SQLite types; no backfill (tests start empty).
CREATE TABLE IF NOT EXISTS project_sales_bills (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL,
  project_id          INTEGER NOT NULL,
  ref_token           TEXT NOT NULL,
  ref_raw             TEXT NOT NULL,
  amount_sen          INTEGER NOT NULL,
  salesperson_name    TEXT,
  report_date         TEXT,
  source_activity_id  INTEGER,
  created_by          INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_sales_bills_token ON project_sales_bills (company_id, project_id, ref_token);
CREATE INDEX IF NOT EXISTS idx_project_sales_bills_project ON project_sales_bills (project_id);
