-- 0182_project_venues_city.sql
--
-- Add `city` column to public.project_venues, completing the address
-- cascade for the PMS Venue Maintenance form (owner spec 2026-07-23:
-- "这边也是要有 city 吧，你添加一个 city 不难吧?").
--
-- Follows mig 0178 (#1059) which added country + postcode. City was
-- deferred there; adding here so the venue address cascade matches the
-- warehouse (mig 0180) shape: Country → State → City → Postcode.
--
-- Backfill: city from scm.my_localities by joining on (state, postcode)
-- when both are set — matches the postcode's canonical city. Rows where
-- either is missing stay NULL for the operator to fill via the drawer.
-- Guarded per-column with information_schema.columns so a partial-schema
-- environment falls through cleanly (mig 0175 hotfix2 lesson).
--
-- Ref: #<PR>. Follows mig 0178 (#1059), mig 0181 (CN+SG seed).

BEGIN;

ALTER TABLE public.project_venues ADD COLUMN IF NOT EXISTS city text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'project_venues' AND column_name = 'city'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'project_venues' AND column_name = 'state'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'project_venues' AND column_name = 'postcode'
  ) THEN
    UPDATE public.project_venues v
       SET city = COALESCE((
             SELECT ml.city FROM scm.my_localities ml
              WHERE ml.state = v.state
                AND ml.postcode = v.postcode
              LIMIT 1
           ), v.city)
     WHERE v.city IS NULL
       AND v.state IS NOT NULL
       AND v.postcode IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_venues_city ON public.project_venues (city);

COMMIT;
