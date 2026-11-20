-- 20261119T1800_hr_attendance_settings.sql
-- HC-0125 punch gates: per-company switches that make a phone punch (clock in /
-- clock out) REFUSED unless it carries a selfie (require_selfie) and/or is within
-- a punch site radius (require_on_site). When a switch is off the selfie / GPS
-- stay evidence only, the behaviour before this migration. One row per company;
-- no row means both off.
--
-- No seed here (switches are turned on per company from the app).
--
-- REVERSAL: DROP TABLE IF EXISTS public.hr_attendance_settings;
--   (Safe: the table is new; dropping it makes every punch record again without
--   a gate, as before this migration.)

CREATE TABLE IF NOT EXISTS public.hr_attendance_settings (
  company_id bigint PRIMARY KEY,
  require_selfie boolean NOT NULL DEFAULT false,
  require_on_site boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer
);
