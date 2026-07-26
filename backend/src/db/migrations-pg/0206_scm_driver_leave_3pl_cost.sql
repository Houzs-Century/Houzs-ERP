-- 0206_scm_driver_leave_3pl_cost.sql — Fleet Module A3: the two remaining
-- dispatch constraints on the A2 assignment flow — a driver's LEAVE, and 3PL
-- OVERFLOW when the own fleet cannot cover a locked day's demand.
--
-- WHY. A2 (fleet-assign.ts) crews each zone-packed trip with a lorry + driver +
-- helper, already excluding lorries Module B has grounded (fleet-availability.ts).
-- A3 adds the last two exclusions the dispatcher works around by hand today:
--   1. a driver on LEAVE that day must not be scheduled, and
--   2. when the region's own AVAILABLE fleet is full, the spill goes to a 3PL
--      carrier — an OUTSOURCE lorry (is_internal=false) — at a CAPTURED cost.
--
-- TWO additive things, one file (repo rule: one migration per slice):
--   1. scm.driver_leave — a driver's date-ranged unavailability. There is NO
--      structured HR leave/attendance source in this ERP (the HR area is
--      commission/payout only: migs 0123/0125), so A3 adds this minimal table.
--      The A2 assigner derives per-DAY driver availability from it and excludes
--      an on-leave driver from that day's crew, the same way
--      fleet-availability.ts excludes a grounded lorry.
--   2. scm.trips.three_pl_cost_centi — the CAPTURED cost of a 3PL-assigned trip.
--      A 3PL trip already models as a trip whose lorry_id is an OUTSOURCE lorry
--      (scm.trips.is_outsourced already derives from lorries.is_internal — see
--      delivery-planning.ts deriveTripOutsourced); the only thing missing was a
--      place to record what the outsourced run COSTS. This column is the SEAM
--      Module C's rate-card will later compute against. Integer sen, nullable
--      (an own-fleet trip leaves it NULL), so no backfill.
--
-- MULTI-COMPANY. scm.driver_leave is scoped per company like the other scm
-- masters: company_id BIGINT NOT NULL REFERENCES public.companies(id).
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, no
-- runtime self-apply. pg-migrate runs the whole file in one transaction.
-- RE-CHECK NUMBER AT MERGE — 0206 was the next free number above 0205 at branch
-- time (0200/0201 were reserved by sibling branches).

SET search_path = scm, public;

-- ── 1. Driver leave ─────────────────────────────────────────────────────────
-- One row per approved absence: a driver is unavailable for delivery on every
-- date in [start_date, end_date] inclusive. reason is free text (MC, annual
-- leave, ...). The A2 assigner treats a driver with a leave row covering a
-- group's date as ineligible to crew that day and reports them in
-- excludedDrivers[]. Everything overridable — the dispatcher can still hand-pick
-- a driver on screen; this only removes them from the AUTO pick.
CREATE TABLE IF NOT EXISTS scm.driver_leave (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   BIGINT NOT NULL REFERENCES public.companies(id),
  driver_id    UUID NOT NULL REFERENCES scm.drivers(id) ON DELETE CASCADE,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       TEXT NULL,
  created_by   UUID NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT driver_leave_range_ck CHECK (start_date <= end_date)
);

-- Lookup is always "which drivers are on leave overlapping a date range", so the
-- index leads with the two columns the assigner filters on.
CREATE INDEX IF NOT EXISTS idx_driver_leave_lookup
  ON scm.driver_leave (company_id, driver_id, start_date, end_date);

-- ── 2. Captured 3PL cost on a trip ──────────────────────────────────────────
-- The cost the dispatcher captures when spilling an overflow trip to a 3PL
-- carrier. NULL on an own-fleet trip. Module C's rate-card will read/compute
-- against this seam; A3 only captures the number the dispatcher enters.
ALTER TABLE scm.trips
  ADD COLUMN IF NOT EXISTS three_pl_cost_centi BIGINT NULL
    CHECK (three_pl_cost_centi IS NULL OR three_pl_cost_centi >= 0);
