-- 0134_trip_stops_route_eta.sql
-- Persist what the route optimiser worked out, so the ETA survives the response.
--
-- POST /trips/:id/optimize-route (Google Directions, #732) returns a per-stop leg
-- distance / duration and a cumulative ETA, but `?apply=true` could only write
-- stop_no — the numbers that make a manifest useful were thrown away. These
-- columns keep them, so the driver's stop list can show "arrive ~09:20" without
-- re-billing Google on every page load.
--
-- eta_offset_s is an OFFSET from the trip's departure, not a clock time: the
-- trip's start can move, and storing a wall-clock ETA would silently go stale the
-- moment it does. The reader adds the offset to the departure it is showing.
--
-- Additive + nullable: a trip that has never been optimised reads NULL, which is
-- honestly "not computed" rather than a fabricated zero.

SET search_path = public, scm;

ALTER TABLE scm.trip_stops ADD COLUMN IF NOT EXISTS leg_distance_m     integer;
ALTER TABLE scm.trip_stops ADD COLUMN IF NOT EXISTS leg_duration_s     integer;
ALTER TABLE scm.trip_stops ADD COLUMN IF NOT EXISTS eta_offset_s       integer;
ALTER TABLE scm.trip_stops ADD COLUMN IF NOT EXISTS route_optimised_at text;
