-- ----------------------------------------------------------------------------
-- 0178 — project_venues address: add country + postcode columns.
--
-- Owner 2026-07-23: "PMS 那边的 Venue 地址，它就只需要填写 State 就会自动带出
-- 国家，不需要填写 Postcode(当然, Postcode 也可以选填), 而且也不需要填写
-- 具体的详细地址". So Venue Maintenance only needs Country + State +
-- optional Postcode — NO Address 1/2 (that's for actual delivery SOs, not
-- venue master).
--
-- Add both columns as NULLABLE, backfill `country` from state via
-- scm.my_localities (same pattern as the warehouse mig 0180). Postcode stays
-- NULL — operator fills it via the drawer when known.
--
-- No CHECK constraint to my_localities.state — canonicalize function on the
-- write path (mig 0175) already handles foreign state names round-trip-safe.
-- Also no schema-level guard against a column reference typo: information_
-- schema check on the read side is what protects (see venues.ts).
-- ----------------------------------------------------------------------------

ALTER TABLE public.project_venues ADD COLUMN IF NOT EXISTS country  text;
ALTER TABLE public.project_venues ADD COLUMN IF NOT EXISTS postcode text;

-- Backfill country from state via my_localities. Idempotent — only fills
-- NULL, leaves anything already picked untouched. Rows whose state isn't
-- in my_localities stay NULL (operator fills via the drawer).
UPDATE public.project_venues v
   SET country = COALESCE((
         SELECT ml.country FROM scm.my_localities ml
          WHERE ml.state = v.state
          LIMIT 1
       ), v.country)
 WHERE v.country IS NULL AND v.state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_venues_country ON public.project_venues (country);
