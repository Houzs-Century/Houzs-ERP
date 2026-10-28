-- ----------------------------------------------------------------------------
-- 0160 — Rename the KL delivery region's display name "Klang Valley" → "KL/Selangor"
-- (owner preference), so a fresh env / DB reset seeds the same label as prod.
--
-- Follow-up to 0159 (which seeded "Klang Valley"). The CODE stays "KL" — the
-- board's cross-border logic and FALLBACK_DEFAULT_REGION key off the code, not
-- the name, so only the label changes. Idempotent: sets the name by code, so
-- re-applying (or applying to any prior state) is a no-op.
-- ----------------------------------------------------------------------------

UPDATE scm.delivery_planning_regions
SET name = 'KL/Selangor'
WHERE code = 'KL';
