-- 0053_scm_delivery_planning_tms.sql
-- Delivery Planning + Driver/Helper/Lorry TMS — SCHEMA FOUNDATION (stage 1 of 4).
-- Self-contained port of 2990 migrations 0195-0201 into the scm schema. Houzs
-- ORIGINALLY had a TMS (2990 reverse-cloned it) but strip-to-core removed it; this
-- rebuilds it inside scm. Additive + run-once (the pg-migrate tracker applies it
-- once inside ONE transaction). NO routes/UI/backfill here.
--
-- VIEW-TRAP NOTE (CoE 2026-06-26 P-2): the new SO columns below (delivery_state,
-- possession_date, house_type, replacement_disposal, referral, amend_date_from_
-- customer, amended_delivery_date, amend_reason) are deliberately NOT added to the
-- column-enumerated view scm.mfg_sales_orders_with_payment_totals (nor v_so_
-- outstanding). The Delivery Planning board + the SO detail read these straight off
-- the BASE table mfg_sales_orders; the SO LIST keeps its narrow view-backed HEADER.
-- So this migration NEVER recreates that 94-column view — the safest way to dodge
-- the "added a col to a shared HEADER that feeds a frozen view -> SO list 500" trap.
-- The backend (stage 2) MUST keep these out of any view-backed list select.
--
-- pg-migrate SPLITTER: the runner splits on /;\s*\n/ and does NOT respect $$.
-- Every DO $$ ... $$ block is therefore written ON ONE LINE so its internal ';'
-- are space-separated (never ';' + newline). Do not reformat them to multi-line.
--
-- Apply BEFORE deploying any code that reads these columns/tables (migrate-before-deploy).

SET search_path = scm, public;

-- ── enums (one-line DO guards) ───────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE scm.delivery_state AS ENUM ('PENDING_DELIVERY','PENDING_SCHEDULE','OVERDUE','DELIVERED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.lorry_type AS ENUM ('LORRY_10FT','LORRY_14FT','LORRY_17FT','LORRY_21FT','VAN','OUTSOURCE','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.delivery_leg_kind AS ENUM ('transit','final'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.delivery_leg_source AS ENUM ('SO','DO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.trip_type AS ENUM ('DELIVERY','SETUP','DISMANTLE','SG','MIXED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.trip_status AS ENUM ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.trip_stop_type AS ENUM ('DELIVERY','PICKUP','SERVICE','SETUP','DISMANTLE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── fleet masters ────────────────────────────────────────────────────────────
ALTER TABLE scm.drivers ADD COLUMN IF NOT EXISTS in_house BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS scm.helpers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  helper_code  TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  contact      TEXT,
  ic_number    TEXT,
  in_house     BOOLEAN NOT NULL DEFAULT true,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_helpers_active ON scm.helpers(active);

CREATE TABLE IF NOT EXISTS scm.lorries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate          TEXT NOT NULL UNIQUE,
  type           scm.lorry_type NOT NULL DEFAULT 'OTHER',
  is_internal    BOOLEAN NOT NULL DEFAULT true,
  warehouse_id   UUID REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  capacity_m3    NUMERIC(8,2),
  capacity_kg    NUMERIC(10,2),
  active         BOOLEAN NOT NULL DEFAULT true,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lorries_active    ON scm.lorries(active);
CREATE INDEX IF NOT EXISTS idx_lorries_internal  ON scm.lorries(is_internal);
CREATE INDEX IF NOT EXISTS idx_lorries_warehouse ON scm.lorries(warehouse_id);

-- ── trips scheduling (2990 0196) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.trips (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_no            TEXT NOT NULL UNIQUE,
  trip_date          DATE NOT NULL,
  lorry_id           UUID REFERENCES scm.lorries(id)    ON DELETE SET NULL,
  driver_id          UUID REFERENCES scm.drivers(id)    ON DELETE SET NULL,
  helper_1_id        UUID REFERENCES scm.helpers(id)    ON DELETE SET NULL,
  helper_2_id        UUID REFERENCES scm.helpers(id)    ON DELETE SET NULL,
  warehouse_id       UUID REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  trip_type          scm.trip_type   NOT NULL DEFAULT 'DELIVERY',
  status             scm.trip_status NOT NULL DEFAULT 'PLANNED',
  is_outsourced      BOOLEAN NOT NULL DEFAULT false,
  clock_in_at        TIMESTAMPTZ,
  clock_out_at       TIMESTAMPTZ,
  total_distance_km  NUMERIC(10,2),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_date      ON scm.trips(trip_date);
CREATE INDEX IF NOT EXISTS idx_trips_lorry     ON scm.trips(lorry_id);
CREATE INDEX IF NOT EXISTS idx_trips_driver    ON scm.trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_warehouse ON scm.trips(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_trips_status    ON scm.trips(status);

CREATE TABLE IF NOT EXISTS scm.trip_stops (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        UUID NOT NULL REFERENCES scm.trips(id) ON DELETE CASCADE,
  stop_no        INTEGER NOT NULL DEFAULT 1,
  stop_type      scm.trip_stop_type NOT NULL DEFAULT 'DELIVERY',
  do_id          UUID REFERENCES scm.delivery_orders(id) ON DELETE SET NULL,
  so_id          UUID,
  customer_name  TEXT,
  address        TEXT,
  revenue_centi  BIGINT NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_stops_trip ON scm.trip_stops(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_stops_do   ON scm.trip_stops(do_id);

CREATE TABLE IF NOT EXISTS scm.lorry_maintenance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lorry_id          UUID NOT NULL REFERENCES scm.lorries(id) ON DELETE CASCADE,
  unavailable_from  DATE NOT NULL,
  unavailable_to    DATE NOT NULL,
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID
);
CREATE INDEX IF NOT EXISTS idx_lorry_maint_lorry ON scm.lorry_maintenance(lorry_id);
CREATE INDEX IF NOT EXISTS idx_lorry_maint_dates ON scm.lorry_maintenance(unavailable_from, unavailable_to);

-- ── delivery_legs — one order across MULTIPLE region trips/dates ──────────────
CREATE TABLE IF NOT EXISTS scm.delivery_legs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type    scm.delivery_leg_source NOT NULL,
  source_id      UUID NOT NULL,
  leg_no         INTEGER NOT NULL DEFAULT 1,
  warehouse_id   UUID REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  trip_id        UUID REFERENCES scm.trips(id) ON DELETE SET NULL,
  leg_date       DATE,
  leg_kind       scm.delivery_leg_kind NOT NULL DEFAULT 'final',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, leg_no)
);
CREATE INDEX IF NOT EXISTS idx_legs_source    ON scm.delivery_legs(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_legs_warehouse ON scm.delivery_legs(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_legs_trip      ON scm.delivery_legs(trip_id);
CREATE INDEX IF NOT EXISTS idx_legs_date      ON scm.delivery_legs(leg_date);

-- ── delivery_order_crew — per-DO crew WITH assign-time snapshot ───────────────
CREATE TABLE IF NOT EXISTS scm.delivery_order_crew (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  do_id              UUID NOT NULL UNIQUE REFERENCES scm.delivery_orders(id) ON DELETE CASCADE,
  driver_1_id        UUID REFERENCES scm.drivers(id) ON DELETE SET NULL,
  driver_2_id        UUID REFERENCES scm.drivers(id) ON DELETE SET NULL,
  helper_1_id        UUID REFERENCES scm.helpers(id) ON DELETE SET NULL,
  helper_2_id        UUID REFERENCES scm.helpers(id) ON DELETE SET NULL,
  lorry_id           UUID REFERENCES scm.lorries(id) ON DELETE SET NULL,
  driver_1_name      TEXT,
  driver_1_ic        TEXT,
  driver_1_contact   TEXT,
  driver_2_name      TEXT,
  driver_2_ic        TEXT,
  driver_2_contact   TEXT,
  helper_1_name      TEXT,
  helper_1_contact   TEXT,
  helper_2_name      TEXT,
  helper_2_contact   TEXT,
  lorry_plate        TEXT,
  assigned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by        UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crew_do      ON scm.delivery_order_crew(do_id);
CREATE INDEX IF NOT EXISTS idx_crew_driver1 ON scm.delivery_order_crew(driver_1_id);
CREATE INDEX IF NOT EXISTS idx_crew_lorry   ON scm.delivery_order_crew(lorry_id);

-- ── delivery_state flag on SO + DO headers (NOT in the SO-list view — P-2) ────
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_state scm.delivery_state;
ALTER TABLE scm.delivery_orders  ADD COLUMN IF NOT EXISTS delivery_state scm.delivery_state;
CREATE INDEX IF NOT EXISTS idx_mfg_so_delivery_state ON scm.mfg_sales_orders(delivery_state);
CREATE INDEX IF NOT EXISTS idx_do_delivery_state     ON scm.delivery_orders(delivery_state);

-- ── HC raw-data fields (2990 0197) — SO-context on the SO, execution on the DO ─
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS possession_date      DATE;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS house_type           TEXT;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS replacement_disposal TEXT;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS referral             TEXT;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS time_range              TEXT;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS time_confirmed          BOOLEAN;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS arrival_at              TIMESTAMPTZ;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS departure_at            TIMESTAMPTZ;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS shipout_date            DATE;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS customer_delivered_date DATE;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS eta_arriving_port       TEXT;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS delivery_substatus      TEXT;

-- ── delivery-date amendments (2990 0199 + 0201) — never overwrite the original ─
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS amend_date_from_customer  DATE;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS amended_delivery_date     DATE;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS amend_reason              TEXT;
ALTER TABLE scm.delivery_orders  ADD COLUMN IF NOT EXISTS arrives_em_warehouse_date DATE;

-- ── config-driven region classification (2990 0198) — Houzs default by STATE ──
CREATE TABLE IF NOT EXISTS scm.delivery_planning_regions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dp_regions_active ON scm.delivery_planning_regions(active);

CREATE TABLE IF NOT EXISTS scm.state_delivery_regions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_key   TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'Malaysia',
  region_id   UUID NOT NULL REFERENCES scm.delivery_planning_regions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state_key, country, region_id)
);
CREATE INDEX IF NOT EXISTS idx_state_delivery_regions_state_key ON scm.state_delivery_regions(state_key);
CREATE INDEX IF NOT EXISTS idx_state_delivery_regions_region_id ON scm.state_delivery_regions(region_id);

-- seed the default Houzs regions (owner-editable in the Regions config UI)
INSERT INTO scm.delivery_planning_regions (code, name, sort_order) VALUES
  ('SELANGOR','Selangor',10),
  ('KL','Kuala Lumpur',20),
  ('NORTHERN','Northern',30),
  ('SOUTHERN','Southern',40),
  ('EAST_COAST','East Coast',50),
  ('EAST_MY','East Malaysia',60)
ON CONFLICT (code) DO NOTHING;

-- seed the default state -> region mappings (covers all 16 MY states; editable)
INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Selangor'),('Putrajaya')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'SELANGOR'
ON CONFLICT (state_key, country, region_id) DO NOTHING;

INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Kuala Lumpur'),('WP Kuala Lumpur'),('W.P. Kuala Lumpur')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'KL'
ON CONFLICT (state_key, country, region_id) DO NOTHING;

INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Pulau Pinang'),('Penang'),('Kedah'),('Perlis'),('Perak')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'NORTHERN'
ON CONFLICT (state_key, country, region_id) DO NOTHING;

INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Johor'),('Melaka'),('Malacca'),('Negeri Sembilan')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'SOUTHERN'
ON CONFLICT (state_key, country, region_id) DO NOTHING;

INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Pahang'),('Terengganu'),('Kelantan')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'EAST_COAST'
ON CONFLICT (state_key, country, region_id) DO NOTHING;

INSERT INTO scm.state_delivery_regions (state_key, country, region_id)
SELECT v.state_key, 'Malaysia', r.id
FROM (VALUES ('Sabah'),('Sarawak'),('Labuan'),('W.P. Labuan')) AS v(state_key)
CROSS JOIN scm.delivery_planning_regions r WHERE r.code = 'EAST_MY'
ON CONFLICT (state_key, country, region_id) DO NOTHING;
