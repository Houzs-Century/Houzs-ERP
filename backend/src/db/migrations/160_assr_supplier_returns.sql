-- D1 / test-tree twin of migrations-pg/20260921T2300_assr_supplier_returns.sql.
-- The prod tree is Postgres; this SQLite copy exists so the generated test
-- schema (tests/generated/test-schema-snapshot.sql) carries the table that
-- getAssrDetail now reads. No backfill here (tests start empty); SQLite types.
CREATE TABLE IF NOT EXISTS assr_supplier_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id         INTEGER NOT NULL,
  round_no        INTEGER NOT NULL,
  pickup_at       TEXT,
  returned_at     TEXT,
  qc_result       TEXT,
  creditor_code   TEXT,
  reason          TEXT,
  note            TEXT,
  created_by      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_assr_supplier_returns_case ON assr_supplier_returns (assr_id, round_no);
