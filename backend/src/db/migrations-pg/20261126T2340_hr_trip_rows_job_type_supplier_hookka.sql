-- Allow SUPPLIER_HOOKKA in hr_trip_rows.job_type.
--
-- #6091 added the SUPPLIER_HOOKKA job type to the trip-pay code (TRIP_JOB_TYPES /
-- kindOfJobType) but not to this table's CHECK, so once it deployed, "Read
-- Delivery Planning" (POST /hr/trip-pay/pull -> syncTripMonth) 500s for EVERY
-- month that has a Hookka supplier pickup: the insert of a SUPPLIER_HOOKKA row is
-- rejected with `violates check constraint "hr_trip_rows_job_type_check"`, so the
-- whole pull (and the nightly sync) writes nothing. Widen the whitelist to match
-- TRIP_JOB_TYPES. kind already allows SUPPLIER (SUPPLIER_HOOKKA's kind), so only
-- the job_type check needs it. Only a DROP+ADD of a CHECK — no data touched.
--
-- REVERSAL: safe only once no hr_trip_rows row carries job_type 'SUPPLIER_HOOKKA':
--   ALTER TABLE public.hr_trip_rows DROP CONSTRAINT hr_trip_rows_job_type_check;
--   ALTER TABLE public.hr_trip_rows ADD CONSTRAINT hr_trip_rows_job_type_check
--     CHECK (job_type = ANY (ARRAY['DELIVERY_ORDER','SETUP','DISMANTLE','SUPPLIER','TRANSFER','LORRY_SERVICE','ASSR_INSPECTION','ASSR_PICKUP','ASSR_SERVICE','NONE']::text[]));

ALTER TABLE public.hr_trip_rows DROP CONSTRAINT IF EXISTS hr_trip_rows_job_type_check;
ALTER TABLE public.hr_trip_rows ADD CONSTRAINT hr_trip_rows_job_type_check
  CHECK (job_type = ANY (ARRAY[
    'DELIVERY_ORDER', 'SETUP', 'DISMANTLE', 'SUPPLIER', 'SUPPLIER_HOOKKA', 'TRANSFER',
    'LORRY_SERVICE', 'ASSR_INSPECTION', 'ASSR_PICKUP', 'ASSR_SERVICE', 'NONE'
  ]::text[]));
