-- 0205_scm_delivery_zones_capacity_locks.sql — Fleet Module A1: postcode -> zone
-- auto-classification, per-lorry capacity ceilings, and reversible day locks.
--
-- WHY. The owner clusters same-region deliveries into 14 AREA ZONES derived
-- DETERMINISTICALLY from the Malaysian postcode (10-14 = Penang, 47/46 = PJ,
-- 43 = Kajang ... — see backend/src/scm/lib/zone-classify.ts), then PACKS each
-- zone's pending orders into lorry-days under a per-lorry capacity ceiling
-- (default 10 SETS, or a revenue fallback). A1 automates the daily manual
-- fitting: classify -> pack -> propose a delivery date -> lock the day.
--
-- THREE additive things, one file (repo rule: one migration per slice):
--   1. scm.delivery_zone_postcodes — the company-editable postcode-prefix -> zone
--      map. NO rows seeded here: the DEFAULT Malaysian map is data in
--      zone-classify.ts, installed by the idempotent seed script
--      backend/scripts/seed-delivery-zones.mjs (repo rule: seeds are scripts,
--      not migrations). The table ships empty; zoneForAddress falls back to the
--      in-code default map until the owner customises.
--   2. scm.lorries capacity columns — max_sets / max_revenue_centi / capacity
--      layer, per lorry. NULL => the packer uses the config defaults (10 /
--      3,000,000 / SETS), so existing lorries need no backfill.
--   3. scm.delivery_day_locks — a REVERSIBLE freeze on a (warehouse, date)
--      proposed schedule. A locked day is closed to re-proposing; unlock =
--      delete the row. Presence = locked.
--
-- MULTI-COMPANY. Scoped per company like the other scm masters: company_id
-- BIGINT NOT NULL REFERENCES public.companies(id). The zone map is UNIQUE per
-- (company_id, zone, prefix_start, prefix_end) so an owner can hold overlapping
-- refinements without a numbered collision; a day lock is UNIQUE per
-- (company_id, warehouse_id, delivery_date).
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, no
-- runtime self-apply. pg-migrate runs the whole file in one transaction.
-- RE-CHECK NUMBER AT MERGE — 0205 was the next free number above 0204 at branch
-- time (0200/0201 were reserved by sibling branches).

SET search_path = scm, public;

-- ── 1. Postcode -> zone map ─────────────────────────────────────────────────
-- Each row maps a first-two-digit postcode prefix RANGE to an area zone. A
-- single-prefix rule sets prefix_start = prefix_end (e.g. 68 = KL/Ampang). The
-- classifier picks the NARROWEST matching range, so an owner-added refinement
-- (e.g. 47 = PUCHONG carved out of the broad 46-47 = PJ block) wins without the
-- owner deleting the broad rule. zone is TEXT (validated in code against the 14
-- canonical zones) so the owner can add their own bucket later.
CREATE TABLE IF NOT EXISTS scm.delivery_zone_postcodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  zone          TEXT NOT NULL,
  prefix_start  SMALLINT NOT NULL CHECK (prefix_start BETWEEN 0 AND 99),
  prefix_end    SMALLINT NOT NULL CHECK (prefix_end   BETWEEN 0 AND 99),
  label         TEXT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID NULL,
  updated_by    UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_zone_postcodes_range_ck CHECK (prefix_start <= prefix_end),
  CONSTRAINT delivery_zone_postcodes_uq UNIQUE (company_id, zone, prefix_start, prefix_end)
);

CREATE INDEX IF NOT EXISTS idx_delivery_zone_postcodes_company
  ON scm.delivery_zone_postcodes (company_id, is_active);

-- ── 2. Per-lorry capacity ceilings ──────────────────────────────────────────
-- The packer fills a lorry-day up to whichever ceiling its layer uses:
--   SETS    — max_sets only (default: config 10)
--   REVENUE — max_revenue_centi only (default: config 3,000,000 = RM30k)
--   BOTH    — whichever binds first
-- NULL columns => the packer uses the config default, so no backfill is needed.
ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS max_sets           INTEGER NULL CHECK (max_sets IS NULL OR max_sets >= 0),
  ADD COLUMN IF NOT EXISTS max_revenue_centi  BIGINT  NULL CHECK (max_revenue_centi IS NULL OR max_revenue_centi >= 0),
  ADD COLUMN IF NOT EXISTS capacity_layer     TEXT    NOT NULL DEFAULT 'SETS'
    CHECK (capacity_layer IN ('SETS', 'REVENUE', 'BOTH'));

-- ── 3. Reversible day locks ─────────────────────────────────────────────────
-- A locked (warehouse, date) freezes that day's proposed schedule so later
-- phases (time windows / sequencing) can build on a stable day. Reversible:
-- unlock = DELETE the row. Presence of a row = the day is locked.
CREATE TABLE IF NOT EXISTS scm.delivery_day_locks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     BIGINT NOT NULL REFERENCES public.companies(id),
  warehouse_id   UUID NULL,
  delivery_date  DATE NOT NULL,
  notes          TEXT NULL,
  locked_by      UUID NULL,
  locked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_day_locks_uq UNIQUE (company_id, warehouse_id, delivery_date)
);

CREATE INDEX IF NOT EXISTS idx_delivery_day_locks_lookup
  ON scm.delivery_day_locks (company_id, warehouse_id, delivery_date);
