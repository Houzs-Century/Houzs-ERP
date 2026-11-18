-- D1 test mirror of migrations-pg/20261118T1200_project_forecast.sql.
CREATE TABLE IF NOT EXISTS project_forecast (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key    TEXT NOT NULL,
  amount_sen  INTEGER NOT NULL CHECK (amount_sen >= 0),
  updated_by  INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forecast_line ON project_forecast (project_id, line_key);
