-- ----------------------------------------------------------------------------
-- 0161 — Rename the KL delivery region's display name "KL/Selangor" → "KL/SEL"
-- (owner preference — matches the SEL state code the ERP already uses in its
-- state-code map). Follow-up to 0160. The CODE stays "KL"; display-only.
-- Idempotent: sets the name by code, so re-applying (or applying to any prior
-- state) is a no-op.
-- ----------------------------------------------------------------------------

UPDATE scm.delivery_planning_regions
SET name = 'KL/SEL'
WHERE code = 'KL';
