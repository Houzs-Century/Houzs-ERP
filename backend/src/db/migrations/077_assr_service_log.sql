-- 077_assr_service_log.sql
--
-- ASSR/QMS v3.1 — Phase E: Service Log refactor (append-only).
--
-- The existing assr_activity table (mig 010 + 064) already records
-- every action on a case, but proposal §14 calls for:
--
--   1. Per-stage_change snapshots of elapsed_days + target_days so the
--      timeline can show "how long this stage actually took" without
--      re-walking the history.
--   2. A `source_channel` stamp so audit can distinguish a desk-app
--      stage change from a portal upload or an inbound email reply.
--   3. Append-only semantics: corrections add a new entry that points
--      at the prior one rather than mutating it. The DB doesn't enforce
--      this — the routes already only INSERT, but we make the intent
--      explicit by surfacing `is_correction` + `references_entry_id`.
--
-- No data migration needed; new columns are nullable for legacy rows.

ALTER TABLE assr_activity ADD COLUMN stage_elapsed_days REAL;
ALTER TABLE assr_activity ADD COLUMN stage_target_days REAL;
ALTER TABLE assr_activity ADD COLUMN source_channel TEXT;
ALTER TABLE assr_activity ADD COLUMN references_entry_id INTEGER;
ALTER TABLE assr_activity ADD COLUMN is_correction INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_assr_activity_source ON assr_activity(source_channel);
CREATE INDEX IF NOT EXISTS idx_assr_activity_refs ON assr_activity(references_entry_id);
