-- ----------------------------------------------------------------------------
-- 0176 — 2990 delivery-region seed + warehouse rename snapshot backfill.
--
-- Owner 2026-07-22 (compare-2990-houzs-masters audit + code review of 0171):
--   1. `scm.state_delivery_regions` has 22 rows for HOUZS, 0 rows for 2990.
--      Delivery Planning bucket-by-region silently returns EMPTY for every
--      2990 state → the board can't route the truck. Mirror HOUZS's regions +
--      state mappings onto 2990 so 2990 can plan deliveries too.
--   2. Mig 0171 renamed 2990 warehouse rows (SLGR → KL, SRK → SRW) and fixed
--      BELAKONG → BALAKONG on the name. Downstream FK references (DO / GRN /
--      inventory) followed automatically — they carry warehouse_id (uuid),
--      not code. BUT `mfg_sales_orders.sales_location` (and its siblings on
--      consignment_orders / consignment_notes / sales_orders) is a TEXT
--      SNAPSHOT of the warehouse code at the time the SO was raised. Those
--      snapshots still hold the old code and now disagree with the master.
--      Rewrite them to match — only for 2990 rows, and only where the value
--      matches the specific old code (never touch a manually-typed override).
--
-- All backfills are guarded: only 2990 rows, only the specific stale value.
-- Idempotent: a re-run finds no matching rows and does nothing.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  co_houzs bigint;
  co_2990  bigint;
BEGIN
  SELECT id INTO co_houzs FROM public.companies WHERE code = 'HOUZS';
  SELECT id INTO co_2990  FROM public.companies WHERE code = '2990';
  IF co_houzs IS NULL OR co_2990 IS NULL THEN
    RAISE NOTICE 'HOUZS / 2990 companies missing — skipping';
    RETURN;
  END IF;

  -- ── 1a. delivery_planning_regions: seed 2990 with the same 6 buckets ────
  -- UNIQUE (company_id, code) after mig 0092, so a same-code row per company
  -- is allowed. Copy code / name / sort_order verbatim; each 2990 row gets a
  -- fresh uuid.
  IF to_regclass('scm.delivery_planning_regions') IS NOT NULL THEN
    INSERT INTO scm.delivery_planning_regions
      (code, name, sort_order, active, company_id)
    SELECT dpr.code, dpr.name, dpr.sort_order, dpr.active, co_2990
      FROM scm.delivery_planning_regions dpr
     WHERE dpr.company_id = co_houzs
       AND NOT EXISTS (
         SELECT 1 FROM scm.delivery_planning_regions x
          WHERE x.company_id = co_2990 AND x.code = dpr.code
       );
  END IF;

  -- ── 1b. state_delivery_regions: mirror HOUZS's mappings onto 2990 ────────
  -- Join each HOUZS mapping row to its region's code, then look up 2990's
  -- region with the SAME code (created in 1a). This carries HOUZS's coverage
  -- across (state_key, country) verbatim — including the multi-spelling rows
  -- like 'Pulau Pinang' + 'Penang' that mig 0053 seeded intentionally.
  --
  -- The table's UNIQUE (state_key, country, region_id) does not include
  -- company_id, but each 2990 row uses 2990's region_id (a different uuid
  -- than HOUZS's), so the triples don't collide.
  IF to_regclass('scm.state_delivery_regions') IS NOT NULL THEN
    INSERT INTO scm.state_delivery_regions
      (state_key, country, region_id, company_id)
    SELECT sdr.state_key, sdr.country, dpr_2990.id, co_2990
      FROM scm.state_delivery_regions sdr
      JOIN scm.delivery_planning_regions dpr_h  ON dpr_h.id = sdr.region_id
      JOIN scm.delivery_planning_regions dpr_2990
             ON dpr_2990.company_id = co_2990
            AND dpr_2990.code       = dpr_h.code
     WHERE sdr.company_id = co_houzs
       AND NOT EXISTS (
         SELECT 1 FROM scm.state_delivery_regions x
          WHERE x.state_key = sdr.state_key
            AND x.country   = sdr.country
            AND x.region_id = dpr_2990.id
       );
  END IF;

  -- ── 2. Warehouse-rename snapshot backfill (2990 rows only) ──────────────
  -- Every table with a `sales_location` text column that snapshotted the
  -- warehouse code. Two renames from mig 0171:
  --     SLGR WAREHOUSE -> KL WAREHOUSE
  --     SRK  WAREHOUSE -> SRW WAREHOUSE
  -- Scoped to company_id = 2990 so a HOUZS row that legitimately holds
  -- "SLGR WAREHOUSE" (if any) is untouched.
  DECLARE
    t text;
    old_code text;
    new_code text;
    pair text[];
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'public.sales_orders',
      'scm.mfg_sales_orders',
      'scm.consignment_orders',
      'scm.consignment_notes'
    ]
    LOOP
      IF to_regclass(t) IS NULL THEN CONTINUE; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE (table_schema || '.' || table_name) = t
           AND column_name = 'sales_location'
      ) THEN CONTINUE; END IF;

      FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ARRAY['SLGR WAREHOUSE','KL WAREHOUSE'],
        ARRAY['SRK WAREHOUSE','SRW WAREHOUSE']
      ]
      LOOP
        old_code := pair[1];
        new_code := pair[2];
        EXECUTE format(
          'UPDATE %s SET sales_location = %L WHERE company_id = %s AND sales_location = %L',
          t, new_code, co_2990, old_code
        );
      END LOOP;
    END LOOP;
  END;
END $$;
