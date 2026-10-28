-- 0166_scm_trip_stops_assr_case.sql
-- assr_case_id on scm.trip_stops — links a stop to the public.assr_cases service
-- case it was scheduled for. Lets an ASSR pickup / delivery / inspection leg
-- scheduled from the Delivery Planning board consume real fleet capacity (a
-- trip_stop) AND be de-duplicated on re-schedule (keyed by trip + case + stop_type).
-- SO/DO stops link via so_id / do_id; ASSR cases live in public.* with no scm uuid,
-- so this is a soft link (bare bigint, no cross-schema FK — same pattern as
-- scm.dp_orders.assr_case_id). Nullable; only ASSR stops set it.
ALTER TABLE scm.trip_stops ADD COLUMN IF NOT EXISTS assr_case_id bigint;
CREATE INDEX IF NOT EXISTS idx_trip_stops_assr_case ON scm.trip_stops (assr_case_id);
