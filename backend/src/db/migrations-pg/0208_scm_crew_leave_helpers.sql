-- 0208_scm_crew_leave_helpers.sql — WS2 Crew Leave: extend scm.driver_leave
-- (mig 0206) to cover HELPERS as well as drivers.
--
-- WHY. Owner: leave should apply to drivers AND helpers (storekeepers live in the
-- helper list, so they are covered too). An on-leave helper must be dropped from
-- that day's auto-crew the same way an on-leave driver already is
-- (driver-availability.ts / fleet-assign.ts).
--
-- Rather than a parallel helper_leave table, this WIDENS the existing one: a row
-- is EITHER a driver's absence OR a helper's absence. driver_id becomes nullable,
-- a new helper_id is added, and a CHECK enforces exactly one is set (XOR). Every
-- existing row has driver_id set + helper_id NULL, so it passes unchanged. The
-- table keeps its name (driver_leave) — the route and the assign loaders reference
-- it by name; the UI just relabels the page "Crew Leave".
--
-- HELPERS have no in_house flag (only scm.drivers does — mig 0060), so there is no
-- external-helper case to guard yet: all helpers are internal today. When WS4 adds
-- a 3PL-company link to helpers, an external guard can follow (see driver-leave.ts,
-- which already guards external DRIVERS via drivers.in_house).
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS + a guarded CHECK), schema-
-- qualified, one transaction. RE-CHECK THE NUMBER AT MERGE — 0208 was the next
-- free number above 0207 at branch time.

SET search_path = scm, public;

-- 1. helper_id — the helper this absence belongs to (mirrors driver_id).
ALTER TABLE scm.driver_leave
  ADD COLUMN IF NOT EXISTS helper_id UUID NULL REFERENCES scm.helpers(id) ON DELETE CASCADE;

-- 2. driver_id is no longer mandatory: a helper-leave row leaves it NULL.
ALTER TABLE scm.driver_leave ALTER COLUMN driver_id DROP NOT NULL;

-- 3. Exactly one of driver_id / helper_id per row (XOR). Guarded so a re-run is a
--    no-op — a numbered migration runs once, but we keep the house idempotency
--    style so a manual re-apply against a partially-migrated DB is safe.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'driver_leave_one_crew_ck'
      AND conrelid = 'scm.driver_leave'::regclass
  ) THEN
    ALTER TABLE scm.driver_leave
      ADD CONSTRAINT driver_leave_one_crew_ck
      CHECK ((driver_id IS NOT NULL) <> (helper_id IS NOT NULL));
  END IF;
END $$;

-- 4. Helper lookup mirrors the driver index — "which helpers are on leave over a
--    date range", the shape the assigner filters on.
CREATE INDEX IF NOT EXISTS idx_driver_leave_helper
  ON scm.driver_leave (company_id, helper_id, start_date, end_date);
