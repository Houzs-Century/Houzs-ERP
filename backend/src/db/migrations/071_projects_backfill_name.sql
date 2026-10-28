-- 071_projects_backfill_name.sql
--
-- Rewrite projects.name to the canonical format
--   {state} [{brand}] {organizer | SOLO} @ {venue}
-- for every non-archived row. Mirrors the `deriveProjectName()`
-- helper in services/projects.ts so a future re-seed plus this
-- migration land at the exact same string for a given row.
--
-- Archived rows are left alone so historical references aren't
-- disturbed. The UPDATE is idempotent — re-running just re-writes
-- to the same string.
UPDATE projects
   SET name = printf(
         '%s [%s] %s @ %s',
         COALESCE(NULLIF(TRIM(state),     ''), '—'),
         COALESCE(NULLIF(TRIM(brand),     ''), '—'),
         COALESCE(NULLIF(TRIM(organizer), ''), 'SOLO'),
         COALESCE(NULLIF(TRIM(venue),     ''), '—')
       ),
       updated_at = datetime('now')
 WHERE archived_at IS NULL;
