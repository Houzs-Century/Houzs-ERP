-- inspection_by — who performs the Pending Inspection stage work:
-- 'own' (our team; links into delivery planning for the visit) or
-- 'supplier'. One stage either way (Nick 2026-07-05: "pending supplier
-- inspection 和 pending inspection 是同阶段"); this flag keeps the
-- distinction the farra sheet tracked via two status values.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_by TEXT;
