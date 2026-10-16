-- 20261014T1500_scm_lorry_positions.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.lorry_positions;
--   Revert the code first (scm/lib/velocity-poll.ts and its */5 cron call write
--   this table). GRANTS: the one GRANT below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its index; no existing row is written or altered.
--
-- WHY (DEV-42, YH 9 Oct: lorry GPS comes from the Velocity/Kinesis trackers, not
-- phones). Velocity's API gives live position only, no history (Velocity email,
-- 14 Oct), so the */5 cron stores each fix here and this table IS the route
-- history. Keyed by lorry + time, not by trip: prod has no trips (8 Oct), and
-- any page (board, capacity, fleet health) can join a DO or a day by lorry + time.
-- scm.trip_locations stays the phone-ping log; the two are separate sources.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.lorry_positions (
  id           uuid             NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   bigint           NOT NULL REFERENCES public.companies(id),
  lorry_id     uuid             NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  device_id    text             NOT NULL,   -- Velocity device id
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  speed_kmh    double precision,
  heading      double precision,
  ignition     boolean,
  street       text,
  recorded_at  timestamptz      NOT NULL,   -- tracker clock (Velocity timestamp)
  received_at  timestamptz      NOT NULL DEFAULT now(),
  -- A parked lorry reports the same fix on every poll; this makes the repeat a no-op.
  -- Also serves "latest per lorry" and "one lorry's day" (backward index scan).
  UNIQUE (lorry_id, recorded_at)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.lorry_positions TO service_role;
