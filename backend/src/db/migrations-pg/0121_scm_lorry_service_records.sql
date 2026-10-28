-- 0121_scm_lorry_service_records.sql
--
-- Per-lorry PURCHASE record, COMPLIANCE expiries, and SERVICE/REPAIR history.
-- Owner 2026-07-17: "把我的维修记录等全部记录下来，这样我之后要查维修记录的时候
-- 也比较方便" — one place to look up what was repaired, when, by whom, for how
-- much, at what odometer, with the invoice attached.
--
-- SCHEMA ONLY. No seed rows (repo rule: demo/test data belongs in a one-shot
-- backend/scripts/seed-*.mjs, never in a numbered migration that runs in prod).
--
-- WHY THIS IS A NEW MIGRATION AND NOT "SURFACING WHAT PROD ALREADY HAS":
-- mig 0015 added model / purchase_date / capacity_* / road_tax_expiry /
-- insurance_expiry / puspakom_expiry / status to *public.lorries*. Those columns
-- are GONE — mig 0055_drop_old_fleet_lorries dropped public.lorries outright
-- (step 5), after migrating 3 rows into scm.lorries and explicitly discarding
-- "model / road_tax_expiry / insurance_expiry / puspakom_expiry ... scm.lorries
-- has no equivalent". So this is not a UI that never arrived on top of live
-- columns. The columns were deleted 40 migrations later along with the
-- pre-strip-to-core Fleet module that read them, and scm.lorries — the table
-- the live /scm/fleet page actually reads via /api/scm/lorries — never had
-- them. This migration adds them to the table that is actually in use.
--
-- ONE THING DELIBERATELY NOT RE-ADDED: `status`. 0015's public.lorries carried
-- a text `status DEFAULT 'active'`, but scm.lorries already has a real
-- `active boolean NOT NULL DEFAULT true` (mig 0053) that the list filter, the
-- Fleet page toggle and the mobile pill all read. A second status column would
-- be a second source of truth for the same question, which is the shape this
-- repo's BUG-HISTORY keeps logging. Availability-over-a-window already has its
-- own home in scm.lorry_maintenance (unavailable_from/to), which the Lorry
-- Capacity dashboard computes repair_days from — that table is an
-- AVAILABILITY WINDOW and is intentionally left alone here. A service RECORD
-- (what was done / cost / odometer / invoice) is a different fact from "this
-- lorry is off the road on these dates", so it gets its own table rather than
-- overloading one that already has a live consumer.
--
-- The service rows are deliberately STRUCTURED (typed columns), not a free-text
-- blob: the owner has said an AI to answer "我之前修过什么" may come later, and a
-- later reader is cheap over clean rows and a rewrite over a text dump. Building
-- that AI is explicitly NOT in scope here.
--
-- IDEMPOTENT + re-runnable (IF NOT EXISTS throughout).
-- NOTE: pg-migrate.mjs splits this file on ";\n" and runs each statement inside
-- ONE transaction, so there are no inner BEGIN/COMMITs and no semicolon ends a
-- comment line (the split runs BEFORE comments are stripped, so a trailing one
-- would cut a statement in half).
--
-- DOWN (manual, not run by the tooling):
--   DROP TABLE IF EXISTS scm.lorry_service_records
--   ALTER TABLE scm.lorries DROP COLUMN IF EXISTS model, DROP COLUMN IF EXISTS
--     purchase_date, ... (mirror of the ADDs below)

SET search_path = scm, public;

-- ── 1. lorries: purchase record + compliance expiries ────────────────────────

-- Freeform make/model, e.g. "Isuzu NPR 3.0". 0055 preserved the old value by
-- concatenating it into notes ("model: ...") when it migrated the 3 rows out of
-- public.lorries, so any pre-existing model text is in notes and this column
-- starts NULL. Not backfilled by parsing notes -- that is an owner data call,
-- and a regex over freeform text is exactly the kind of silent guess this repo
-- has been bitten by. Reported instead.
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS model text;

-- Purchase record. purchase_date existed on the dropped public.lorries and is
-- re-added here. price + invoice are NEW -- neither had any column anywhere.
-- Money is BIGINT cents (repo convention: *_centi), never a float.
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_date          date;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_price_centi   bigint;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_invoice_key   text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_invoice_name  text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_invoice_mime  text;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS purchase_invoice_size  integer;

-- Compliance expiries (Malaysia, in-house goods vehicles). These store the date
-- printed on the actual document, entered by the operator -- the system does NOT
-- compute the next expiry from the cadence. That is deliberate: road tax and
-- insurance renew ANNUALLY and a Puspakom inspection for a commercial goods
-- vehicle is due EVERY 6 MONTHS, but the authoritative date is the one on the
-- disc/cover note/report, and a computed "+12 months" would quietly disagree
-- with it after any early or late renewal. The cadence is surfaced as a LABEL on
-- each tile in the UI so the operator knows what they are renewing into
-- (frontend/src/vendor/shared/lorry-compliance.ts), and the colour is driven by
-- the stored date alone.
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS road_tax_expiry  date;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS insurance_expiry date;
ALTER TABLE lorries ADD COLUMN IF NOT EXISTS puspakom_expiry  date;

-- Partial indexes: the compliance strip only ever asks "what expires soon",
-- so the NULL rows (nothing recorded yet) are dead weight in the index.
CREATE INDEX IF NOT EXISTS idx_lorries_road_tax_expiry
  ON lorries (road_tax_expiry) WHERE road_tax_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lorries_insurance_expiry
  ON lorries (insurance_expiry) WHERE insurance_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lorries_puspakom_expiry
  ON lorries (puspakom_expiry) WHERE puspakom_expiry IS NOT NULL;

-- ── 2. lorry_service_records — the service/repair history ────────────────────

CREATE TABLE IF NOT EXISTS lorry_service_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stamped with the ACTIVE company on insert, mirroring scm.lorries. NOT used
  -- to scope reads: lorries.ts:43 declares the fleet UNIFIED across companies
  -- ("every company's TMS page shows the same lorries"), so a lorry's service
  -- history must be visible wherever the lorry is. Nullable + no FK, matching
  -- how 0083 retro-fitted company_id onto the other TMS tables.
  company_id     bigint,
  lorry_id       uuid NOT NULL REFERENCES lorries(id) ON DELETE CASCADE,
  service_date   date NOT NULL,
  -- What was done. NOT NULL because a record with no description answers none
  -- of the questions this table exists for.
  description    text NOT NULL,
  workshop       text,
  cost_centi     bigint NOT NULL DEFAULT 0,
  -- Odometer AT THE TIME OF SERVICE (owner option A: entered on the service
  -- record, not per-trip). This is the ONLY odometer source in the system, so
  -- the reading is exactly as fresh as the last service and nothing may present
  -- a current-mileage figure derived from it. Nullable: a record whose km was
  -- not noted is still worth keeping.
  odometer_km    integer,
  -- The invoice. ONE per record (a service has one bill), so this is a column
  -- set rather than a child table -- cf. mfg_sales_orders.slip_image_key.
  -- invoice_key is the R2 object key in the SO_ITEM_PHOTOS bucket.
  invoice_key    text,
  invoice_name   text,
  invoice_mime   text,
  invoice_size   integer,
  -- The workshop's "come back at" targets, as told to the operator at this
  -- service. Both optional and independent: whichever arrives first is what is
  -- due. next_service_km is stored raw and is only interpretable against
  -- odometer_km on THIS row -- see the honesty note in lorry-compliance.ts.
  next_service_date date,
  next_service_km   integer,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- bigint (public.users.id), NOT the uuid its sibling TMS tables use, and the
  -- divergence is deliberate. Inside /api/scm/* the ported `user.id` is the
  -- PINNED scm.staff system uuid shared by every caller (scm/env.ts:14-21), so
  -- scm.trips.created_by / scm.lorry_maintenance.created_by record the same
  -- constant for everyone -- they identify nobody. `houzsUser.id` is the only
  -- per-person identity in that namespace and it is an integer. The owner's
  -- ask is a record he can look things up in later, so "who entered this" has
  -- to be real. Nullable + no FK: a row stays useful if the user is deleted.
  created_by     bigint
);

-- The one hot query: "this lorry's history, newest first". Also serves the
-- "latest record" lookup the Next Service tile does.
CREATE INDEX IF NOT EXISTS idx_lorry_service_records_lorry_date
  ON lorry_service_records (lorry_id, service_date DESC);

-- Guard the odometer against a typo that would poison the only mileage figure
-- in the system. A negative reading is meaningless, and 0 is treated as "not
-- recorded" by the UI rather than a real reading.
ALTER TABLE lorry_service_records DROP CONSTRAINT IF EXISTS lorry_service_records_odometer_nonneg;
ALTER TABLE lorry_service_records ADD CONSTRAINT lorry_service_records_odometer_nonneg CHECK (odometer_km IS NULL OR odometer_km >= 0);

ALTER TABLE lorry_service_records DROP CONSTRAINT IF EXISTS lorry_service_records_cost_nonneg;
ALTER TABLE lorry_service_records ADD CONSTRAINT lorry_service_records_cost_nonneg CHECK (cost_centi >= 0);
