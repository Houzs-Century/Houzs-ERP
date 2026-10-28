-- D1 / SQLite parity for PG migration 0224 — per-attachment Ongoing/Done
-- action timeline on defect-list uploads (owner 2026-07-29).
CREATE TABLE IF NOT EXISTS project_checklist_attachment_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  remark TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pcaa_attachment ON project_checklist_attachment_actions(attachment_id);
