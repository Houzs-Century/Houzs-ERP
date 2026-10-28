-- 028_organizers.sql
-- Lookup table for the project organizer field. Kept as a *separate*
-- table (rather than enforcing FK from projects.organizer) so the
-- existing free-text data keeps working — the frontend uses this list
-- as a picker but the projects.organizer column stays free text. New
-- entries typed inline get added to the lookup so subsequent projects
-- pick from a clean list.

CREATE TABLE IF NOT EXISTS project_organizers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_organizers_active ON project_organizers(active);

-- Seed from existing project rows so the picker has something on day 1.
INSERT OR IGNORE INTO project_organizers (name)
SELECT DISTINCT TRIM(organizer)
  FROM projects
 WHERE organizer IS NOT NULL
   AND TRIM(organizer) != '';
