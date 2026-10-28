-- 101_checklist_amendments_test_parity.sql
--
-- TEST-SCHEMA PARITY for the ported feat/checklist-amendments features.
--
-- Production runs on Supabase (Postgres) and gets these via migrations-pg
-- mig 0015. D1 is retired in prod, but the numbered migrations under
-- src/db/migrations are still replayed against the isolated SQLite DB the
-- vitest suite uses (see backend/vitest.config.ts + tests/setup.ts). This
-- file mirrors the 0015 additions that the SQLite baseline (schema.sql) and
-- existing D1 migrations don't already provide, so tests exercise the same
-- shape as prod.
--
-- Already present in the SQLite test schema, so NOT repeated here:
--   * lorries fleet/compliance columns  -> 005_fleet_management.sql
--   * project_checklist(.*).pill_kind/pill_value -> 090_payment_deposit_pills.sql
--
-- setup.ts swallows "duplicate column" / "already exists", so this stays
-- safe even if a column ever lands in the baseline later.

-- ── projects: phase crew editor JSON (0015) ───────────────────
ALTER TABLE projects ADD COLUMN setup_crew     TEXT;
ALTER TABLE projects ADD COLUMN dismantle_crew TEXT;

-- ── users: company phone (0015) ───────────────────────────────
ALTER TABLE users ADD COLUMN company_phone TEXT;

-- ── sales_entry_activity: append-only edit history (0015) ─────
CREATE TABLE IF NOT EXISTS sales_entry_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  note       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sales_entry_activity_entry
  ON sales_entry_activity(entry_id, created_at);
