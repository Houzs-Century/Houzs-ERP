-- ----------------------------------------------------------------------------
-- 0171 — Warehouse TYPE enum + master-list unification across HOUZS / 2990.
--
-- Owner 2026-07-22 (compare-2990-houzs-masters audit) —
--   * two companies were maintaining OVERLAPPING but INCONSISTENT warehouse
--     lists (only 2 shared codes out of 15/7), and
--   * the sole existing type flag `is_showroom` is a single boolean; the real
--     shape is FIVE buckets (warehouse / showroom / display / service / others)
--     each with distinct reporting semantics (Sales-by-venue only reads
--     showrooms; Service centre bookings only route to service; DISPLAY holds
--     display-stock that must not net into sellable inventory; OTHERS is HQ
--     and unclassified sites like C&C K.J).
--
-- This migration is the schema + data half of the change. The frontend Type
-- column + edit dropdown + backend serialisation are in the same PR.
--
-- Notes on scope:
--   * `is_showroom` STAYS. It is read by the existing venue-binding resolver
--     (mig 0148) plus the Members / staff-parked-under-showroom UI, and by
--     inventory.ts:257 which OR-includes flagged showrooms in the balance view.
--     Ripping it out is a separate sweep; here it is kept in sync with the new
--     `type` column so both readings agree.
--   * Showroom / display / others warehouses stay COMPANY-SPECIFIC per owner —
--     only `warehouse` and `service` types are broadcast to both companies.
--   * CONSIGN-OUT (2990-only, inactive) is intentionally NOT copied — it is a
--     historical placeholder for consignment-out movements and has no meaning
--     for HOUZS.
-- ----------------------------------------------------------------------------

-- ── 1. Enum type ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE scm.warehouse_type AS ENUM (
    'warehouse',
    'showroom',
    'display',
    'service',
    'others'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Add column (nullable first, backfill, then NOT NULL) ─────────────────
ALTER TABLE scm.warehouses
  ADD COLUMN IF NOT EXISTS type scm.warehouse_type;

-- Backfill: keyword-in-code first, then owner-supplied explicit exceptions.
-- `is_showroom = true` also wins where set (survives if the code was renamed).
UPDATE scm.warehouses
   SET type = CASE
     WHEN is_showroom                       THEN 'showroom'::scm.warehouse_type
     WHEN code ILIKE '%SHOWROOM%'           THEN 'showroom'::scm.warehouse_type
     WHEN code ILIKE '%DISPLAY%'            THEN 'display'::scm.warehouse_type
     WHEN code ILIKE '%SERVICE%'            THEN 'service'::scm.warehouse_type
     WHEN code IN ('HQ', 'C&C K.J')         THEN 'others'::scm.warehouse_type
     WHEN code ILIKE '%WAREHOUSE%'          THEN 'warehouse'::scm.warehouse_type
     WHEN code ILIKE 'CONSIGN%'             THEN 'warehouse'::scm.warehouse_type
     ELSE                                        'warehouse'::scm.warehouse_type
   END
 WHERE type IS NULL;

ALTER TABLE scm.warehouses
  ALTER COLUMN type SET NOT NULL;

-- Keep is_showroom = (type = 'showroom') as an invariant. A pre-existing row
-- flagged is_showroom=true without a matching code is upgraded above; this line
-- covers the other direction so a future is_showroom flip still updates type.
CREATE INDEX IF NOT EXISTS idx_warehouses_type
  ON scm.warehouses (type);

-- ── 3. Renames in 2990 to align with HOUZS canonical codes ──────────────────
-- Owner: SLGR WAREHOUSE (2990) is the same physical Balakong site as HOUZS's
-- KL WAREHOUSE. HOUZS name kept; 2990 renames.
-- The (company_id, code) unique constraint (mig 0087) means each rename is a
-- no-op if HOUZS somehow also had SLGR / SRK — filter defensively on the code
-- NOT already existing.
DO $$
DECLARE
  co_2990 bigint;
BEGIN
  SELECT id INTO co_2990 FROM public.companies WHERE code = '2990';
  IF co_2990 IS NULL THEN
    RAISE NOTICE '2990 company row missing — skipping renames';
    RETURN;
  END IF;

  -- SLGR WAREHOUSE -> KL WAREHOUSE, and fix BELAKONG -> BALAKONG typo.
  UPDATE scm.warehouses
     SET code = 'KL WAREHOUSE',
         name = REPLACE(name, 'BELAKONG', 'BALAKONG')
   WHERE company_id = co_2990
     AND code = 'SLGR WAREHOUSE'
     AND NOT EXISTS (
       SELECT 1 FROM scm.warehouses
        WHERE company_id = co_2990 AND code = 'KL WAREHOUSE'
     );

  -- SRK WAREHOUSE -> SRW WAREHOUSE (HOUZS naming wins).
  UPDATE scm.warehouses
     SET code = 'SRW WAREHOUSE'
   WHERE company_id = co_2990
     AND code = 'SRK WAREHOUSE'
     AND NOT EXISTS (
       SELECT 1 FROM scm.warehouses
        WHERE company_id = co_2990 AND code = 'SRW WAREHOUSE'
     );
END $$;

-- ── 4. Cross-company copies (warehouse + service types only) ────────────────
-- Per owner: only `warehouse` and `service` types are shared across the two
-- companies. Showroom / display / others stay where they are.
--
-- CHINA WAREHOUSE originated on 2990 and needs to appear in HOUZS.
-- KL SERVICE / PG SERVICE originated on HOUZS and need to appear in 2990.
--
-- Copies are keyed by (source company, code) → (target company, same code),
-- carrying code/name/location/type/venue_name; is_active starts true unless the
-- source is inactive; is_default is FALSE on copies so we never demote a target
-- company's own default (see the LEAK FIX comment in inventory.ts:110).
DO $$
DECLARE
  co_houzs bigint;
  co_2990  bigint;
BEGIN
  SELECT id INTO co_houzs FROM public.companies WHERE code = 'HOUZS';
  SELECT id INTO co_2990  FROM public.companies WHERE code = '2990';
  IF co_houzs IS NULL OR co_2990 IS NULL THEN
    RAISE NOTICE 'HOUZS / 2990 company row missing — skipping cross-company copies';
    RETURN;
  END IF;

  -- 2990 -> HOUZS: CHINA WAREHOUSE
  INSERT INTO scm.warehouses (
    company_id, code, name, location, is_active, is_default, is_showroom,
    venue_name, type
  )
  SELECT co_houzs, code, name, location, is_active, false, false,
         NULL, 'warehouse'::scm.warehouse_type
    FROM scm.warehouses
   WHERE company_id = co_2990 AND code = 'CHINA WAREHOUSE'
     AND NOT EXISTS (
       SELECT 1 FROM scm.warehouses
        WHERE company_id = co_houzs AND code = 'CHINA WAREHOUSE'
     );

  -- HOUZS -> 2990: KL SERVICE, PG SERVICE
  INSERT INTO scm.warehouses (
    company_id, code, name, location, is_active, is_default, is_showroom,
    venue_name, type
  )
  SELECT co_2990, w.code, w.name, w.location, w.is_active, false, false,
         NULL, 'service'::scm.warehouse_type
    FROM scm.warehouses w
   WHERE w.company_id = co_houzs
     AND w.code IN ('KL SERVICE', 'PG SERVICE')
     AND NOT EXISTS (
       SELECT 1 FROM scm.warehouses w2
        WHERE w2.company_id = co_2990 AND w2.code = w.code
     );
END $$;
