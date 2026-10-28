-- 038_venues.sql
-- Lookup table for the project venue field. Mirrors the
-- project_organizers pattern (migration 028): a separate table the
-- frontend uses as a picker, but the projects.venue column stays free
-- text so existing data keeps working. New entries typed inline are
-- added to the lookup so subsequent projects pick from a clean list.

CREATE TABLE IF NOT EXISTS project_venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT,                              -- optional: pre-fill projects.state when picked
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_venues_active ON project_venues(active);

-- Seed from existing project rows so the picker has something on day 1.
INSERT OR IGNORE INTO project_venues (name, state)
SELECT DISTINCT TRIM(venue), MAX(state)
  FROM projects
 WHERE venue IS NOT NULL
   AND TRIM(venue) != ''
 GROUP BY TRIM(venue) COLLATE NOCASE;
