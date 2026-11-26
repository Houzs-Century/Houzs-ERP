-- 20261126T1700_scm_lorry_positions_odometer.sql
-- REVERSAL: ALTER TABLE scm.lorry_positions DROP COLUMN IF EXISTS odometer_m;
--
-- WHAT THIS CHANGES: one nullable column on scm.lorry_positions; no row is written.
--
-- WHY: GPS km is straight lines between 5-minute fixes and reads low on bends.
-- iTrack's /api/track carries the device odometer (`mileage`, metres); the poll
-- now stores it per fix so a day's odometer km = the sum of forward steps.
-- NULL = no reading (Velocity fixes, or iTrack sent -1).

ALTER TABLE scm.lorry_positions
  ADD COLUMN IF NOT EXISTS odometer_m bigint CHECK (odometer_m >= 0);
