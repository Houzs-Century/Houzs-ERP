-- 0309 — SO header canonical warehouse binding (ADDITIVE).
--
-- WHAT. Add a header `warehouse_id` (uuid -> scm.warehouses) to
-- scm.mfg_sales_orders and backfill it from the free-text `sales_location`
-- snapshot, resolving CODE first then NAME, within the SAME company, and ONLY
-- where the match is unambiguous (exactly one warehouse). `sales_location` is
-- KEPT: the rows that do not resolve still need it, so this migration does NOT
-- drop it — it is the fallback until every location resolves.
--
-- WHY ADDITIVE, and why the view is NOT touched. The canonical warehouse binding
-- is the per-LINE scm.mfg_sales_order_items.warehouse_id that MRP / allocation /
-- costing already read; this adds the HEADER snapshot so the header carries the
-- same canonical id its lines do, instead of only a human-typed string. Adding a
-- base-table column does not change the projection of
-- scm.mfg_sales_orders_with_payment_totals (its SELECT enumerates columns, so a
-- new column is simply absent from it) — so there is NO view recreate here and
-- NO 0189 grant hazard. Exposing warehouse_id through the view, if ever wanted,
-- is a separate reviewed change.
--
-- RESOLUTION SPEC. The pure resolver backend/scripts/lib/resolve-warehouse-location.mjs
-- (unit-tested by backend/tests/resolveWarehouseLocation.test.mjs) is the tested
-- statement of the rule these two UPDATEs implement in SQL: trim; CODE exact,
-- one match -> resolve; else NAME exact, one match -> resolve; ambiguous (>1) or
-- no match -> leave NULL (stay on sales_location). Never guess.
--
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN warehouse_id;
--   Reversible in full — sales_location is untouched, so the snapshot this
--   backfills is re-derivable and nothing is lost by dropping the column.
-- Verified against: production census run 32280818981 (2026-08-19, read-only,
--   PR #2508's workflow). Of 2823 non-cancelled SOs carrying a non-empty
--   sales_location, 2772 resolve to exactly one warehouse (ALL by code, 0 by
--   name-fallback), 0 are ambiguous, and 51 do not resolve — every one of those
--   the single value "SLGR WAREHOUSE" in company 2, which has no matching
--   scm.warehouses row. Those 51 stay on sales_location by design.

BEGIN;

ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS warehouse_id uuid
  REFERENCES scm.warehouses(id) ON DELETE SET NULL;

-- Pass 1 — resolve by CODE (company-scoped, unambiguous only).
UPDATE scm.mfg_sales_orders so
   SET warehouse_id = w.id
  FROM scm.warehouses w
 WHERE so.warehouse_id IS NULL
   AND NULLIF(btrim(so.sales_location), '') IS NOT NULL
   AND w.company_id = so.company_id
   AND w.code = btrim(so.sales_location)
   AND (SELECT count(*) FROM scm.warehouses w2
         WHERE w2.company_id = so.company_id
           AND w2.code = btrim(so.sales_location)) = 1;

-- Pass 2 — NAME fallback, ONLY where no code matched at all (company-scoped,
-- unambiguous only). Census measured 0 rows here today; the pass is kept so the
-- rule is complete and correct for future data.
UPDATE scm.mfg_sales_orders so
   SET warehouse_id = w.id
  FROM scm.warehouses w
 WHERE so.warehouse_id IS NULL
   AND NULLIF(btrim(so.sales_location), '') IS NOT NULL
   AND w.company_id = so.company_id
   AND w.name = btrim(so.sales_location)
   AND NOT EXISTS (SELECT 1 FROM scm.warehouses wc
                    WHERE wc.company_id = so.company_id
                      AND wc.code = btrim(so.sales_location))
   AND (SELECT count(*) FROM scm.warehouses w2
         WHERE w2.company_id = so.company_id
           AND w2.name = btrim(so.sales_location)) = 1;

COMMIT;
