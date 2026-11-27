-- Per-row allowance override for Trip Pay (owner 2026-11-27).
--
-- A setup / dismantle / ASSR / supplier / transfer row's job allowance is worked
-- out from the rate card by job type + event type + 1st/2nd trip, with no way to
-- hand-set the amount for a one-off (e.g. a night fair that pays more than the
-- standard setup rate). This adds an optional per-row override: when
-- allowance_override_sen is not null, that row's job allowance is exactly that
-- amount instead of the rate-card value. NULL (the default) keeps the rate card.
-- Set only by HR on the Trip Pay edit drawer (the row is marked hr_edited, so the
-- nightly sync never overwrites it). Commission (Delivery order) is unaffected:
-- it still reads local_total_sen.
--
-- REVERSAL: safe only once no hr_trip_rows row carries a non-null
-- allowance_override_sen (dropping it discards those HR overrides):
--   ALTER TABLE public.hr_trip_rows DROP COLUMN IF EXISTS allowance_override_sen;

ALTER TABLE public.hr_trip_rows ADD COLUMN IF NOT EXISTS allowance_override_sen bigint;
