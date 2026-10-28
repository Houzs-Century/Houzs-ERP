-- 064_assr_workflow_extensions.sql
--
-- Quality module (ASSR) workflow refresh, driven by ops feedback:
--
--   1. Stage can now move forward, back, or skip — the linear
--      registration → triage → action → logistics → resolution → closed
--      pipeline was too rigid. CHECK constraint on `stage` already
--      allows any of these values, so no schema change needed for the
--      transition relaxation; the gate moves to the service layer
--      (TRANSITIONS table dropped) and the UI (free-form picker).
--
--   2. Activity log entries are now categorised so the timeline can
--      split into a Purchasing thread (internal team / supplier ops)
--      vs Customer-visible thread (milestones safe to share).
--      `system` covers auto-emitted events (stage change, assignment).
--
--   3. Two new dates on the case header:
--        supplier_pickup_at — when 3PL collected items from supplier
--        items_ready_at     — when the goods came back ready
--      Both surface as columns in the case list + sort keys.
--
--   4. stage_changed_at lets the UI show a "X days in stage" lead-time
--      column without scanning assr_activity per row.

ALTER TABLE assr_cases ADD COLUMN supplier_pickup_at TEXT;
ALTER TABLE assr_cases ADD COLUMN items_ready_at TEXT;
ALTER TABLE assr_cases ADD COLUMN stage_changed_at TEXT;

ALTER TABLE assr_activity ADD COLUMN category TEXT DEFAULT 'system'
  CHECK (category IN ('purchasing','customer','system'));

-- Seed stage_changed_at from the most recent stage_change row per case
-- (fall back to created_at when there's been no transition yet).
UPDATE assr_cases
   SET stage_changed_at = COALESCE(
     (SELECT MAX(created_at) FROM assr_activity
       WHERE assr_id = assr_cases.id AND action = 'stage_change'),
     created_at
   );

-- Existing 'note' activity rows are user-posted internal notes. The
-- new `customer` and `system` lanes are populated by the new code
-- paths going forward; nothing historical was customer-visible.
UPDATE assr_activity SET category = 'purchasing' WHERE action = 'note';

CREATE INDEX IF NOT EXISTS idx_assr_activity_category
  ON assr_activity(assr_id, category);
CREATE INDEX IF NOT EXISTS idx_assr_supplier_pickup ON assr_cases(supplier_pickup_at);
CREATE INDEX IF NOT EXISTS idx_assr_items_ready ON assr_cases(items_ready_at);
CREATE INDEX IF NOT EXISTS idx_assr_stage_changed ON assr_cases(stage_changed_at);
