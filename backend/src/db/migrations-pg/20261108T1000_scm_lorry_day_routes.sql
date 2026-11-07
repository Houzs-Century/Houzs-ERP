-- Lorry routes by road (owner 2026-11-08): each lorry's day is driven from its home
-- warehouse, through its stops in order, and back; Google gives the road distance and
-- driving time, kept here per lorry and day so Last Mile, Lorry Capacity and Fleet
-- Health read one figure and Google is asked again only when the stops change.
--
-- Warehouses gain a map position. Until now a depot was found by geocoding its
-- address, and the warehouses carry only a state, so Balakong landed in central
-- Kuala Lumpur. The owner gave the two warehouses' map pins (Google Maps, 2026-11-08):
-- KL warehouse (Balakong) 3.0263633, 101.7339527; PG warehouse 5.3007432, 100.4273393.
-- These are configuration the owner supplied, set on the two rows by id.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.lorry_day_routes;
--   ALTER TABLE scm.warehouses DROP COLUMN IF EXISTS latitude, DROP COLUMN IF EXISTS longitude;

ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS latitude  double precision;
ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS longitude double precision;

UPDATE scm.warehouses SET latitude = 3.0263633, longitude = 101.7339527
 WHERE id = 'e309c399-697c-4174-967f-ae2c888ad999' AND latitude IS NULL;
UPDATE scm.warehouses SET latitude = 5.3007432, longitude = 100.4273393
 WHERE id = '24f982eb-b19f-45da-ba05-97ceb7a9d0e4' AND latitude IS NULL;

CREATE TABLE IF NOT EXISTS scm.lorry_day_routes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  lorry_id    UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  route_date  DATE NOT NULL,
  -- The home point and the stops in order the figure was worked out for; a different
  -- key means the run changed and the figure is worked out again.
  stop_key    TEXT NOT NULL,
  stop_count  INTEGER NOT NULL,
  distance_m  INTEGER NOT NULL,
  duration_s  INTEGER NOT NULL,
  polyline    TEXT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lorry_day_routes_uq UNIQUE (company_id, lorry_id, route_date)
);

CREATE INDEX IF NOT EXISTS idx_lorry_day_routes_date
  ON scm.lorry_day_routes (company_id, route_date);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.lorry_day_routes TO service_role;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
