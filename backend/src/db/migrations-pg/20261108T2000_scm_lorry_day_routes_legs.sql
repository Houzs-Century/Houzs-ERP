-- Each stop's drive from the stop before (owner 2026-11-08): Google already answers
-- the run leg by leg; the legs are kept beside the day's total so Last Mile can show,
-- on every order, how far and how long the lorry drives to reach it. Array of
-- { ref, distanceM, durationS } in run order; the last entry (ref null) is the drive
-- home. NULL on a figure kept before this column: the next run works it out again.
--
-- REVERSAL:
--   ALTER TABLE scm.lorry_day_routes DROP COLUMN IF EXISTS legs;

ALTER TABLE scm.lorry_day_routes ADD COLUMN IF NOT EXISTS legs JSONB NULL;
