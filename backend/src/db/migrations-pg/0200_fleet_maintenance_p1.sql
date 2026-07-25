-- 0200_fleet_maintenance_p1.sql — Fleet Maintenance & Compliance, Phase 1.
--
-- ⚠️ RE-CHECK NUMBER AT MERGE. 0200 was the next free number when this branch
-- was cut (tip: 0199_scm_trip_locations). Migrations run in prod on every
-- deploy and DUPLICATE numbers wedge the runner, so re-list the tree at merge
-- time and renumber this file to highest-on-main + 1 if 0200 was taken by
-- another PR in the meantime. pg-migrate keys on the FULL filename, so a gap is
-- harmless; a collision is not.
--
-- WHAT THIS DELIVERS (schema only — no seed data; the owner loads the real
-- fleet with backend/scripts/seed-fleet-maintenance.mjs):
--   * fleet_vehicles             — the lorry master (one profile per lorry).
--   * fleet_compliance_documents — the compliance VAULT. Renewals are APPENDED
--     as new rows (never overwritten) so the full renewal history survives; the
--     "current" document for a type is the latest-expiring row (see
--     services/fleet-status.ts currentDocsByType).
--
-- DERIVED STATUS, NOT A COLUMN. A vehicle's status
-- (AVAILABLE / SERVICE_DUE / PLANNED_MAINTENANCE / WAITING_PARTS / BREAKDOWN /
-- COMPLIANCE_BLOCKED / OUT_OF_SERVICE) is DERIVED at read time by
-- deriveVehicleStatus() from compliance + the manual out_of_service flag + the
-- mileage/date-vs-next-service fields. It is deliberately NOT stored, so it can
-- never drift from the facts it is computed from.
--
-- RELATIONSHIP TO scm.lorries (owner decision, deferred). The SCM subsystem
-- already carries a lorry master (scm.lorries, mig 0053/0121) with flat
-- road_tax/insurance/puspakom expiry columns and scm.lorry_service_records for
-- repair history. This module is intentionally SELF-CONTAINED (own master, own
-- vault with true renewal history + APAD/cross-border + PUSPAKOM result) and
-- does NOT touch scm.*. Reconciling the two masters (fold scm.lorries in, or
-- keep Fleet Maintenance as the compliance system of record keyed by plate) is
-- an owner call for a follow-up phase — see docs/modules/fleet-maintenance.md.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), explicit public schema,
-- company_id scoped like the rest of the app. pg-migrate runs the whole file in
-- one transaction.

SET search_path = public;

-- ── fleet_vehicles — the lorry master ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fleet_vehicles (
  id                     BIGSERIAL PRIMARY KEY,
  company_id             BIGINT NOT NULL,
  -- Registration plate. Unique per company (a plate identifies one lorry).
  plate                  TEXT NOT NULL,
  -- Dispatch origin warehouse / region (e.g. 'KL', 'PG'). Free text in Phase 1;
  -- a later phase can FK it to the warehouses master.
  region                 TEXT NULL,
  -- Assigned driver name, denormalized from the owner's Driver List sheet for
  -- Phase 1. A later phase links this to a real users / scm.drivers row.
  driver_name            TEXT NULL,
  vehicle_type           TEXT NULL,
  model                  TEXT NULL,
  -- Current odometer + the next-service target. isServiceDue() compares them.
  current_mileage_km     INTEGER NULL CHECK (current_mileage_km IS NULL OR current_mileage_km >= 0),
  next_service_km        INTEGER NULL CHECK (next_service_km IS NULL OR next_service_km >= 0),
  next_service_date      DATE NULL,
  -- The manual OUT_OF_SERVICE input to the status machine (parked / sold /
  -- written off). NOT the status itself — status is always derived.
  out_of_service         BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_service_reason  TEXT NULL,
  notes                  TEXT NULL,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The real Houzs user id (bigint), not a pinned system row.
  created_by             BIGINT NULL,
  CONSTRAINT fleet_vehicles_company_plate_uq UNIQUE (company_id, plate)
);

CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_company_active
  ON public.fleet_vehicles (company_id, active);

-- ── fleet_compliance_documents — the compliance vault (append-only history) ──
-- One row = one issued/renewed document. To RENEW, insert a NEW row (the prior
-- row stays as history); never UPDATE the expiry of an existing row. The
-- current document per (vehicle, doc_type) is the latest-expiring row.
CREATE TABLE IF NOT EXISTS public.fleet_compliance_documents (
  id                     BIGSERIAL PRIMARY KEY,
  company_id             BIGINT NOT NULL,
  vehicle_id             BIGINT NOT NULL REFERENCES public.fleet_vehicles (id) ON DELETE CASCADE,
  -- PUSPAKOM | ROAD_TAX | INSURANCE | APAD | CROSS_BORDER. CHECK rather than an
  -- enum type so adding a kind later is an app change, not a migration on a
  -- pg enum. Mirrors services/fleet-status.ts COMPLIANCE_DOC_TYPES.
  doc_type               TEXT NOT NULL CHECK (doc_type IN ('PUSPAKOM','ROAD_TAX','INSURANCE','APAD','CROSS_BORDER')),
  document_ref           TEXT NULL,
  issue_date             DATE NULL,
  expiry_date            DATE NULL,
  cost_centi             BIGINT NULL CHECK (cost_centi IS NULL OR cost_centi >= 0),
  -- Who owns the renewal (person / department).
  owner                  TEXT NULL,
  -- PUSPAKOM only: PASS | FAIL. A FAIL grounds the vehicle
  -- (COMPLIANCE_BLOCKED) until a fresh PASS row is appended.
  result                 TEXT NULL CHECK (result IS NULL OR result IN ('PASS','FAIL')),
  -- PUSPAKOM FAIL: the deadline to re-present the vehicle for reinspection.
  reinspection_deadline  DATE NULL,
  notes                  TEXT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             BIGINT NULL
);

-- The dashboard and the per-vehicle vault both read by (vehicle, doc_type)
-- ordered by expiry — this covers "current document per type" and the renewal
-- history list.
CREATE INDEX IF NOT EXISTS idx_fleet_compliance_vehicle_type_expiry
  ON public.fleet_compliance_documents (company_id, vehicle_id, doc_type, expiry_date DESC);

-- ── LATER-PHASE SEAMS (documented, not built) ───────────────────────────────
-- Phase 2+ adds the richer status inputs. deriveVehicleStatus() already accepts
-- them (openWorkOrder, breakdownActive); the tables that will feed them are NOT
-- created here to avoid empty prod surface nobody writes:
--   * fleet_work_orders     — planned/unplanned jobs (feeds PLANNED_MAINTENANCE
--                             / WAITING_PARTS).
--   * fleet_breakdown_cases — active breakdowns (feeds BREAKDOWN + downtime).
--   * fleet_preventive_plans, tyre/component tracking, mileage trip-capture.
-- Their shapes live in docs/modules/fleet-maintenance.md so the seam is a
-- written contract, not a guess.
