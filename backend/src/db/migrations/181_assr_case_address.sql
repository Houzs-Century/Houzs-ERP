-- D1 test mirror of migrations-pg/20261117T2030_assr_case_address.sql.
CREATE TABLE IF NOT EXISTS assr_case_address (
  assr_id     INTEGER PRIMARY KEY REFERENCES assr_cases(id) ON DELETE CASCADE,
  postcode    TEXT,
  city        TEXT,
  state       TEXT,
  updated_by  INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
