-- Service Case list + summary: index the correlated stage_since lookup.
--
-- Both the list row SELECT (services/assr.ts listAssrCases) and the /summary
-- "aging" aggregate (routes/assr.ts) compute how long a case has sat in its
-- current stage with the SAME correlated subquery, evaluated ONCE PER ROW:
--
--   SELECT MAX(a.created_at) FROM assr_activity a
--    WHERE a.assr_id = c.id AND a.action = 'stage_change' AND a.to_value = c.stage
--
-- assr_activity carried only idx_assr_activity_case (assr_id) and
-- idx_assr_activity_category (assr_id, category) — neither covers `action` or
-- `to_value`, so every row's subquery fetched that case's whole activity trail
-- and filtered it in memory. The Board and Calendar views ask for up to the
-- 200-row server cap, so that is 200 such scans on the hot triage tab.
--
-- This composite matches the predicate exactly and carries created_at, so the
-- MAX() is answered by reading one end of the index instead. Non-partial on
-- purpose: a partial index keyed on action = 'stage_change' would be smaller,
-- but it silently stops being used the day someone edits the predicate, and
-- the table's existing indexes are all plain composites (0002_indexes.sql).
--
-- Additive and non-unique — it changes no write path. Precedent for the class:
-- 0221_pfl_occurred_index.sql, which fixed the Finance Lines 504 the same way.
--
-- NOTE: re-check this file's NUMBER at merge time by re-listing the tree.
-- pg-migrate tracks by full filename and DUPLICATE numbers are what break it;
-- parallel PRs pick the same one otherwise (CLAUDE.md, Migrations).

CREATE INDEX IF NOT EXISTS idx_assr_activity_stage_since
  ON assr_activity (assr_id, action, to_value, created_at);
