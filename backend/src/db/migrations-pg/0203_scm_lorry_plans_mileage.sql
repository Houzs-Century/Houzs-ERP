-- 0203_scm_lorry_plans_mileage.sql — Fleet Maintenance & Compliance, Phase 2.
--
-- ⚠️ RE-CHECK NUMBER AT MERGE. At branch time main was at 0202 (the Phase-1
-- compliance vault) and 0200/0201 were reserved by a parallel branch, so 0203
-- was the next free number. Migrations run in prod on every deploy and DUPLICATE
-- numbers wedge the runner (pg-migrate keys on the FULL filename, so a gap is
-- harmless — a collision is not). Re-list the tree at merge and renumber to
-- highest-on-main + 1 if 0203 was taken in the meantime.
--
-- WHAT THIS ADDS (schema only — no seed data; the owner backfills a sensible
-- default plan set per lorry with backend/scripts/seed-fleet-plans.mjs):
--
--   scm.lorry_maintenance_plans  — ONE preventive-maintenance plan per COMPONENT
--     per lorry (engine oil, oil+filter, gearbox oil, brake inspection/pads,
--     tyres, battery, alignment, air-con, suspension, cooling system, PUSPAKOM
--     prep). Each plan carries a km interval AND/OR a months interval; the plan
--     is DUE on WHICHEVER comes first. next_due_km / next_due_date are DERIVED
--     (last_done_km + interval_km ; last_done_date + interval_months) in
--     services/fleet-status.ts — not stored here, so they can never drift from
--     the inputs. One plan per (lorry, component) is enforced by a UNIQUE index.
--
--   scm.lorry_mileage_readings  — the daily odometer capture. The primary flow
--     is the driver marking the day "fully complete" after the last drop and
--     entering the odometer + a dashboard photo (source = DAY_COMPLETE), one
--     reading per day. Readings may NOT go backwards (the write route rejects a
--     rollback) and an abnormal one-day jump is FLAGGED for review, never
--     silently accepted (flagged column). GPS trip distance (scm.trip_locations,
--     Phase 4) may be shown as a cross-check but is NEVER written here as the
--     odometer.
--
-- WHY THESE SIT ON scm.lorries. scm.lorries (mig 0053) is THE fleet master —
-- plate UNIQUE, referenced by scm.trips.lorry_id and scm.delivery_order_crew.
-- Both new tables are children of it (ON DELETE CASCADE), exactly like the
-- Phase-1 vault (scm.lorry_compliance_documents, mig 0202) and the existing
-- scm.lorry_service_records (mig 0121). This module does NOT create a parallel
-- master (mig 0055 already dropped a duplicate public.lorries once).
--
-- COMPANY SCOPE — matches scm.lorry_service_records / the Phase-1 vault, NOT a
-- hard scope. The fleet is UNIFIED across companies (scm.lorries has no
-- company_id). company_id is STAMPED on insert for provenance but NOT used to
-- scope reads. Nullable + no FK, mirroring the siblings.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), scm-schema-qualified.
-- Money is BIGINT cents (*_centi), never a float. pg-migrate runs the whole file
-- in ONE transaction.

SET search_path = scm, public;

-- ── Preventive maintenance plans — one per (lorry, component) ────────────────
CREATE TABLE IF NOT EXISTS scm.lorry_maintenance_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stamped with the active company on insert; NOT read for scoping (unified
  -- fleet — see the header). Nullable + no FK, mirroring the siblings.
  company_id        BIGINT,
  lorry_id          UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  -- The component this plan covers. CHECK (not enum) so adding a component later
  -- is an app change. Mirrors PLAN_COMPONENTS in services/fleet-status.ts.
  component         TEXT NOT NULL CHECK (component IN (
    'ENGINE_OIL','OIL_FILTER','GEARBOX_OIL','BRAKE_INSPECTION','BRAKE_PADS',
    'TYRES','BATTERY','ALIGNMENT','AIRCON','SUSPENSION','COOLING_SYSTEM',
    'PUSPAKOM_PREP'
  )),
  -- The two intervals. At least one must be set (a plan due on neither km nor
  -- months is not a plan); either alone is valid — the plan fires on WHICHEVER
  -- comes first.
  interval_km       INTEGER CHECK (interval_km IS NULL OR interval_km > 0),
  interval_months   INTEGER CHECK (interval_months IS NULL OR interval_months > 0),
  -- The last time this component was serviced. next_due_* is derived from these
  -- (last_done_km + interval_km ; last_done_date + interval_months) — the app
  -- computes it, this table stores only the raw facts.
  last_done_date    DATE,
  last_done_km      INTEGER CHECK (last_done_km IS NULL OR last_done_km >= 0),
  workshop          TEXT,
  est_cost_centi    BIGINT CHECK (est_cost_centi IS NULL OR est_cost_centi >= 0),
  notes             TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The real person (public.users.id, bigint), same choice as the siblings.
  created_by        BIGINT,
  -- A plan must be actionable: at least one interval.
  CONSTRAINT lorry_maintenance_plans_has_interval
    CHECK (interval_km IS NOT NULL OR interval_months IS NOT NULL)
);

-- One plan per component per lorry (the "per component" rule). A partial unique
-- index lets a retired plan be re-created without a hard delete if ever needed,
-- but the app upserts on (lorry, component) so in practice there is exactly one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lorry_plan_lorry_component
  ON scm.lorry_maintenance_plans (lorry_id, component);

-- ── Daily mileage readings — the day-complete odometer capture ──────────────
CREATE TABLE IF NOT EXISTS scm.lorry_mileage_readings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT,
  lorry_id      UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  reading_date  DATE NOT NULL,
  odometer_km   INTEGER NOT NULL CHECK (odometer_km >= 0),
  -- DAY_COMPLETE (driver marks the day done) | MANUAL (office correction) |
  -- SERVICE (captured off a service record). Mirrors MILEAGE_SOURCES.
  source        TEXT NOT NULL DEFAULT 'DAY_COMPLETE'
                  CHECK (source IN ('DAY_COMPLETE','MANUAL','SERVICE')),
  -- R2 key of the dashboard-odometer photo (nullable — MANUAL/SERVICE rarely
  -- carry one). The photo lives in R2; only its key is stored, like the POD key.
  photo_ref     TEXT,
  -- Set when the reading tripped the abnormal-jump guard: accepted, but a human
  -- should eyeball it. A rollback (odometer < previous) is REJECTED by the write
  -- route and never reaches this table, so `flagged` here means abnormal jump.
  flagged       BOOLEAN NOT NULL DEFAULT FALSE,
  note          TEXT,
  entered_by    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot query: latest reading per lorry (drives the "current odometer" the
-- plans measure against, and the no-rollback guard's previous value).
CREATE INDEX IF NOT EXISTS idx_lorry_mileage_lorry_date
  ON scm.lorry_mileage_readings (lorry_id, reading_date DESC, created_at DESC);

-- One DAY_COMPLETE reading per lorry per day (the "one reading per day" rule for
-- the driver flow). MANUAL/SERVICE corrections are not constrained — the office
-- may need to add a back-dated fix alongside the driver's entry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lorry_mileage_daycomplete_per_day
  ON scm.lorry_mileage_readings (lorry_id, reading_date)
  WHERE source = 'DAY_COMPLETE';

-- ── LATER-PHASE SEAMS (documented, not built) ───────────────────────────────
-- Work orders, breakdown cases and tyre/component SERIAL lifecycle are Phase 3;
-- deriveVehicleStatus() already accepts openWorkOrder + breakdownActive but the
-- tables that feed them are still not created here. GPS odometer cross-check
-- reads scm.trip_locations (mig 0199) at render time — no column here mirrors it.
