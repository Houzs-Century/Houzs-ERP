-- 20261117T2100_hr_trip_pay_v2.sql
--
-- WHY. Owner-approved Trip Pay redesign (2026-11-17): job types are Delivery
-- Planning's own, Setup / Dismantle pay by the project's event type with an
-- automatic 2nd-trip rate, outstation goes by state groups, overnight by
-- clock-out tiers, and the month fills itself every night (00:05 MYT) from
-- Delivery Planning and the Projects module without overwriting HR's edits.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: eight new
-- columns on public.hr_trip_rows (nullable, or NOT NULL with a constant
-- default, so no rewrite of meaning and no row written), one index, and one
-- new empty table. Existing rows keep job_type NULL: the code reads their job
-- type from the old `kind` column (jobTypeOfKind), so stored history is never
-- rewritten. Rates versions are JSON and untouched; an old version is
-- normalized on read and keeps computing exactly as before.
--   hr_trip_rows.job_type          DP job type (DELIVERY_ORDER, SETUP, ...); NULL = read from kind
--   hr_trip_rows.event_type        EXHIBITION / ROADSHOW for Setup / Dismantle, from the project
--   hr_trip_rows.postcode          the stop's postcode, as known
--   hr_trip_rows.trip_ref          the lorry run (DP trip id or project leg), for the 2nd-trip rule
--   hr_trip_rows.venue_key         the venue / project served, for the 2nd-trip rule
--   hr_trip_rows.hr_edited         HR changed the row by hand: the nightly read never overwrites it
--   hr_trip_rows.source_missing_at the source stop was cancelled / deleted: flagged for HR, not removed
--   hr_trip_rows.removed_at        HR removed a row read from Delivery Planning: kept (so the
--                                  nightly read does not add it back) but paid nothing
--   hr_trip_sync_state             per company: the nightly read's watermark and last result
--
-- MULTI-COMPANY. company_id on every row; the routes and the nightly read
-- write the company's own rows only.
--
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: revert the code first (routes/hr-trip-pay.ts, routes/lib/hr-trip-store.ts,
--   routes/lib/hr-trip-sync.ts and the 00:05 cron call in index.ts are the only
--   readers and writers); then:
--   DROP TABLE IF EXISTS public.hr_trip_sync_state;
--   DROP INDEX IF EXISTS public.idx_hr_trip_rows_source_ref;
--   ALTER TABLE public.hr_trip_rows DROP COLUMN IF EXISTS job_type, DROP COLUMN IF EXISTS event_type,
--     DROP COLUMN IF EXISTS postcode, DROP COLUMN IF EXISTS trip_ref, DROP COLUMN IF EXISTS venue_key,
--     DROP COLUMN IF EXISTS hr_edited, DROP COLUMN IF EXISTS source_missing_at,
--     DROP COLUMN IF EXISTS removed_at;
--   (rows with removed_at set would then pay again: delete them first if that matters)
--   Rows the nightly read added stay (their `kind` column carries the old kind).
--   GRANTS: none to re-apply; the new table only has anon / authenticated revoked.

ALTER TABLE public.hr_trip_rows
  ADD COLUMN IF NOT EXISTS job_type text
    CHECK (job_type IN ('DELIVERY_ORDER', 'SETUP', 'DISMANTLE', 'SUPPLIER', 'TRANSFER', 'LORRY_SERVICE', 'ASSR_INSPECTION', 'ASSR_PICKUP', 'ASSR_SERVICE', 'NONE')),
  ADD COLUMN IF NOT EXISTS event_type text CHECK (event_type IN ('EXHIBITION', 'ROADSHOW')),
  ADD COLUMN IF NOT EXISTS postcode text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS trip_ref text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS venue_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hr_edited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_missing_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_hr_trip_rows_source_ref ON public.hr_trip_rows (company_id, source, source_ref);

CREATE TABLE IF NOT EXISTS public.hr_trip_sync_state (
  company_id      bigint      PRIMARY KEY,
  watermark       timestamptz,
  last_run_at     timestamptz,
  last_summary    text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Kept off the PostgREST anon / authenticated roles, like the other trip pay tables.
REVOKE ALL ON public.hr_trip_sync_state FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_trip_sync_state FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_trip_sync_state FROM authenticated;
END IF; END $$;
