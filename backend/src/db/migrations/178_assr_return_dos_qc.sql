-- D1 test mirror of migrations-pg/20261110T1400_assr_return_dos_and_qc_notes.sql.
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
CREATE TABLE IF NOT EXISTS assr_case_qc_notes (
  assr_id         INTEGER PRIMARY KEY REFERENCES assr_cases(id) ON DELETE CASCADE,
  qc_inspected_at TEXT,
  qc_by           TEXT,
  qc_findings     TEXT,
  updated_by      INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
