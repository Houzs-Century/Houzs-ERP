-- 20260909T0800_contractor_share_export_scope.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One column on the contractor picker table: what a contractor's public
--   calendar link exports when its holder presses Export to Excel — the MONTH
--   on screen (the rule since 2026-09-09 morning) or the WHOLE YEAR on screen.
--   Owner 2026-09-09: "YEN CREATIVE, BAND OF GORILA, JH CONTRACTOR — these 3
--   contractor once click export will export the whole year schedule ... for
--   akemi and dreamart will export by month remain". A per-row setting rather
--   than a list of names in code, so the office can flip it from Project
--   Maintenance ("Export whole year"). Additive, idempotent; the three seeded
--   rows are matched on the exact names read off this database on 2026-09-09.
--
-- REVERSAL: ALTER TABLE project_contractors DROP COLUMN IF EXISTS share_export_scope;
-- Verified against: prod Supabase anogrigyjbduyzclzjgn — the four project_contractors rows
--   read on 2026-09-09 (BAND OF GORILLA SDN BHD, DREAM ART (M) SDN BHD, JH CONTRACTOR,
--   YEN CREATIVE SDN BHD); the ALTER/UPDATE themselves are UNTESTED until deploy.yml runs them.

ALTER TABLE project_contractors
  ADD COLUMN IF NOT EXISTS share_export_scope text NOT NULL DEFAULT 'month';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_contractors_share_export_scope_check'
  ) THEN
    ALTER TABLE project_contractors
      ADD CONSTRAINT project_contractors_share_export_scope_check
      CHECK (share_export_scope IN ('month', 'year'));
  END IF;
END $$;

UPDATE project_contractors
   SET share_export_scope = 'year'
 WHERE lower(name) IN ('yen creative sdn bhd', 'band of gorilla sdn bhd', 'jh contractor')
   AND share_export_scope <> 'year';
