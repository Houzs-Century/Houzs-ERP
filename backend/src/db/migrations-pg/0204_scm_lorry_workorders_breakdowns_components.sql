-- 0204_scm_lorry_workorders_breakdowns_components.sql — Fleet Maintenance, Phase 3.
--
-- ⚠️ RE-CHECK NUMBER AT MERGE. At branch time main was at 0203 (Phase-2 plans +
-- mileage); 0200/0201 were reserved by parallel branches, 0202/0203 are the
-- Phase-1/2 fleet migrations. 0204 was the next free number when this file was
-- written. Migrations run in prod on every deploy and DUPLICATE numbers wedge the
-- runner (pg-migrate keys on the FULL filename, so a gap is harmless — a
-- collision is not). Re-list the tree at merge and renumber to highest-on-main + 1
-- if 0204 was taken in the meantime.
--
-- WHAT THIS ADDS (schema only — no seed data). THREE linked areas that finally
-- FEED the two status seams deriveVehicleStatus() has carried since Phase 1
-- (openWorkOrder + breakdownActive), plus the tyre/component SERIAL lifecycle:
--
--   1. scm.lorry_breakdown_cases   — a breakdown / roadside-incident log. A
--      CRITICAL, still-unresolved case grounds the lorry: it feeds breakdownActive
--      → deriveVehicleStatus() returns BREAKDOWN → canDispatch() is false. This is
--      the ESTABLISHED mechanism (the derived-status seam), NOT a parallel
--      out-of-service flag and NOT a status column on scm.lorries.
--
--   2. scm.lorry_work_orders + scm.lorry_work_order_parts — maintenance work
--      orders with a state machine (Reported → Diagnosed → Approved → In Repair →
--      Waiting Parts → Completed → Verified). An OPEN work order in IN_REPAIR
--      feeds PLANNED_MAINTENANCE; one in WAITING_PARTS feeds WAITING_PARTS. The
--      work-order total (labour + parts + outside service + towing + tax) feeds
--      the real this-month repair-spend + costliest-vehicle KPIs, alongside
--      scm.lorry_service_records. A work order may be SPAWNED from a breakdown
--      case (breakdown_case_id) and may install/replace a component (component_id).
--
--   3. scm.lorry_components + scm.lorry_component_events — the tyre / battery /
--      brake-pad / etc. SERIAL lifecycle. km_used and cost_per_km are DERIVED in
--      services/fleet-status.ts (never stored — they cannot drift). Answers: when
--      was this rear-left tyre changed; is this battery under warranty; why the
--      repeated brakes in three months (the component-events history).
--
-- WHY THESE SIT ON scm.lorries. scm.lorries (mig 0053) is THE fleet master —
-- plate UNIQUE, referenced by scm.trips.lorry_id + scm.delivery_order_crew. All
-- new tables are children of it (ON DELETE CASCADE), exactly like the Phase-1
-- vault (mig 0202) and Phase-2 plans/mileage (mig 0203). This module does NOT
-- create a parallel master (mig 0055 already dropped a duplicate public.lorries).
--
-- COMPANY SCOPE — matches the Phase-1/2 fleet tables, NOT a hard scope. The fleet
-- is UNIFIED across companies (scm.lorries has no company_id). company_id is
-- STAMPED on insert for provenance but NOT used to scope reads. Nullable + no FK,
-- mirroring the siblings.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), scm-schema-qualified. Money
-- is BIGINT cents (*_centi), never a float. pg-migrate runs the whole file in ONE
-- transaction.

SET search_path = scm, public;

-- ── 1. Breakdown / roadside-incident cases ──────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.lorry_breakdown_cases (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         BIGINT,
  lorry_id           UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  -- When the breakdown happened + where (roadside GPS the driver captured).
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  gps_lat            DOUBLE PRECISION,
  gps_lng            DOUBLE PRECISION,
  -- What broke (free text kind, e.g. "Tyre burst", "Engine overheat") + how bad.
  fault_type         TEXT,
  severity           TEXT NOT NULL DEFAULT 'MINOR'
                       CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  -- Can the lorry still limp home, or is it stranded? A CRITICAL case grounds the
  -- lorry regardless (see the status seam in services/fleet-status.ts).
  still_drivable     BOOLEAN NOT NULL DEFAULT TRUE,
  -- R2 keys of the driver's photos/video of the scene (JSON array of strings).
  media_refs         JSONB,
  driver_description TEXT,
  towing_company     TEXT,
  towing_cost_centi  BIGINT CHECK (towing_cost_centi IS NULL OR towing_cost_centi >= 0),
  workshop           TEXT,
  -- The incident timeline: when recovery/tow started, and when the lorry was
  -- recovered (back at a workshop / drivable). recovery_time NULL = still down.
  breakdown_start    TIMESTAMPTZ,
  recovery_time      TIMESTAMPTZ,
  -- The delivery trip this breakdown hit, if any (nullable — a breakdown between
  -- trips has none). ON DELETE SET NULL: deleting a trip must not delete history.
  affected_trip_id   UUID REFERENCES scm.trips(id) ON DELETE SET NULL,
  -- OPEN (just reported) → TOWING → IN_WORKSHOP → RESOLVED. A non-RESOLVED
  -- CRITICAL case is what feeds breakdownActive → BREAKDOWN status.
  status             TEXT NOT NULL DEFAULT 'OPEN'
                       CHECK (status IN ('OPEN','TOWING','IN_WORKSHOP','RESOLVED')),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT
);

-- The hot query: active (non-resolved) cases per lorry, newest first — the
-- breakdownActive seam and the dashboard's active-breakdown count read this.
CREATE INDEX IF NOT EXISTS idx_lorry_breakdown_lorry_status
  ON scm.lorry_breakdown_cases (lorry_id, status, occurred_at DESC);

-- ── 3. Components (tyre / battery / … SERIAL lifecycle) ─────────────────────
-- Declared before work orders so a work order can FK a component it installs.
CREATE TABLE IF NOT EXISTS scm.lorry_components (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           BIGINT,
  lorry_id             UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  -- The component kind. CHECK (not enum) so adding a kind later is an app change.
  component_type       TEXT NOT NULL CHECK (component_type IN (
    'TYRE','BATTERY','BRAKE_PADS','ALTERNATOR','STARTER','GEARBOX',
    'AIR_COMPRESSOR','OTHER'
  )),
  -- Physical position on the vehicle (tyres/brakes); NA for whole-vehicle parts.
  position             TEXT NOT NULL DEFAULT 'NA' CHECK (position IN (
    'FRONT_L','FRONT_R','REAR_L','REAR_R','NA'
  )),
  brand                TEXT,
  model                TEXT,
  size                 TEXT,
  serial               TEXT,
  -- Fitment facts. km_used (removed_km|current − fitted_km) and cost_per_km
  -- (purchase_price_centi / km_used) are DERIVED in services/fleet-status.ts.
  fitted_date          DATE,
  fitted_km            INTEGER CHECK (fitted_km IS NULL OR fitted_km >= 0),
  purchase_price_centi BIGINT CHECK (purchase_price_centi IS NULL OR purchase_price_centi >= 0),
  -- Tyre tread depth in mm (0.1 precision), nullable — only tyres carry one.
  tread_depth          NUMERIC(4,1) CHECK (tread_depth IS NULL OR tread_depth >= 0),
  removed_date         DATE,
  removed_km           INTEGER CHECK (removed_km IS NULL OR removed_km >= 0),
  warranty_until       DATE,
  -- ACTIVE (currently fitted) | REMOVED (taken off; removed_* set). One ACTIVE
  -- component per (lorry, position) among tyre-style positions is enforced below.
  status               TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','REMOVED')),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           BIGINT
);

-- The hot query: components for a lorry, active first.
CREATE INDEX IF NOT EXISTS idx_lorry_components_lorry_status
  ON scm.lorry_components (lorry_id, status, component_type);

-- Only ONE active component may occupy a real position at a time (you cannot have
-- two active rear-left tyres). NA is exempt — many whole-vehicle parts (battery,
-- alternator, …) share NA. Enforced by a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lorry_component_active_position
  ON scm.lorry_components (lorry_id, position)
  WHERE status = 'ACTIVE' AND position <> 'NA';

-- Rotation / puncture / repair / inspection history for a component.
CREATE TABLE IF NOT EXISTS scm.lorry_component_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT,
  component_id  UUID NOT NULL REFERENCES scm.lorry_components(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN (
    'ROTATION','PUNCTURE','REPAIR','INSPECTION','OTHER'
  )),
  event_date    DATE NOT NULL,
  odometer_km   INTEGER CHECK (odometer_km IS NULL OR odometer_km >= 0),
  -- For a ROTATION: the position the component moved to (audit of where it went).
  to_position   TEXT CHECK (to_position IS NULL OR to_position IN (
    'FRONT_L','FRONT_R','REAR_L','REAR_R','NA'
  )),
  cost_centi    BIGINT CHECK (cost_centi IS NULL OR cost_centi >= 0),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_lorry_component_events_component
  ON scm.lorry_component_events (component_id, event_date DESC);

-- ── 2. Maintenance work orders + parts ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.lorry_work_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           BIGINT,
  lorry_id             UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  -- The state machine. CHECK mirrors WORK_ORDER_STATES in services/fleet-status.ts.
  -- Reported → Diagnosed → Approved → In Repair → Waiting Parts → Completed →
  -- Verified. IN_REPAIR feeds PLANNED_MAINTENANCE; WAITING_PARTS feeds
  -- WAITING_PARTS (both only while the WO is OPEN, i.e. not COMPLETED/VERIFIED).
  status               TEXT NOT NULL DEFAULT 'REPORTED' CHECK (status IN (
    'REPORTED','DIAGNOSED','APPROVED','IN_REPAIR','WAITING_PARTS',
    'COMPLETED','VERIFIED'
  )),
  problem              TEXT,
  diagnosis            TEXT,
  workshop             TEXT,
  -- Money legs (BIGINT cents). total is DERIVED at read time (labour + parts +
  -- outside service + towing + tax) so it can never drift from the legs.
  labour_centi         BIGINT NOT NULL DEFAULT 0 CHECK (labour_centi >= 0),
  outside_service_centi BIGINT NOT NULL DEFAULT 0 CHECK (outside_service_centi >= 0),
  towing_centi         BIGINT NOT NULL DEFAULT 0 CHECK (towing_centi >= 0),
  tax_centi            BIGINT NOT NULL DEFAULT 0 CHECK (tax_centi >= 0),
  warranty_until       DATE,
  -- R2 keys of the invoice / quote / photo (JSON arrays of strings).
  invoice_refs         JSONB,
  quote_refs           JSONB,
  photo_refs           JSONB,
  reported_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  est_complete         TIMESTAMPTZ,
  actual_complete      TIMESTAMPTZ,
  approved_by          BIGINT,
  verified_by          BIGINT,
  -- A work order may be spawned FROM a breakdown case, and may install/replace a
  -- component. Both nullable; ON DELETE SET NULL keeps the WO if the link is gone.
  breakdown_case_id    UUID REFERENCES scm.lorry_breakdown_cases(id) ON DELETE SET NULL,
  component_id         UUID REFERENCES scm.lorry_components(id) ON DELETE SET NULL,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           BIGINT
);

-- The hot query: open work orders per lorry (the status seam + Open-problem /
-- Downtime board columns), newest first.
CREATE INDEX IF NOT EXISTS idx_lorry_work_orders_lorry_status
  ON scm.lorry_work_orders (lorry_id, status, reported_at DESC);

CREATE TABLE IF NOT EXISTS scm.lorry_work_order_parts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      BIGINT,
  work_order_id   UUID NOT NULL REFERENCES scm.lorry_work_orders(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  part_no         TEXT,
  qty             NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_centi BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_centi >= 0),
  serial          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_lorry_work_order_parts_wo
  ON scm.lorry_work_order_parts (work_order_id);
