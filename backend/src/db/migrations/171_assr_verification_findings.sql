-- D1 test mirror of migrations-pg/20261021T1000_assr_verification_findings.sql.
CREATE TABLE IF NOT EXISTS assr_case_verification_notes (
  assr_id             INTEGER PRIMARY KEY REFERENCES assr_cases(id) ON DELETE CASCADE,
  inspection_findings TEXT,
  next_action         TEXT,
  pending_with        TEXT,
  updated_by          INTEGER,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
