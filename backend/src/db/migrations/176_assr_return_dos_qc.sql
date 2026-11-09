-- D1 test mirror of migrations-pg/20261109T1300_assr_return_dos_qc.sql.
CREATE TABLE IF NOT EXISTS assr_return_dos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  do_no TEXT NOT NULL,
  do_date TEXT,
  received_at TEXT,
  received_by TEXT,
  remarks TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assr_return_dos_case ON assr_return_dos (assr_id);
ALTER TABLE assr_cases ADD COLUMN qc_inspected_at TEXT;
ALTER TABLE assr_cases ADD COLUMN qc_by TEXT;
ALTER TABLE assr_cases ADD COLUMN qc_findings TEXT;
