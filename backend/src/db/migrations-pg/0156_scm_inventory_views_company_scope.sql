-- 0156_scm_inventory_views_company_scope.sql — cross-company LEAK FIX for the
-- two inventory catalogue-rollup views (isolation sweep A3 + B1).
--
-- ############################################################################
-- ## STAGING-FIRST — DO NOT MERGE UNTIL VALIDATED ON STAGING.               ##
-- ##                                                                        ##
-- ## v_inventory_all_skus is NOT in this repo's migration tree: it (like    ##
-- ## the report views 0106 recreates) was created by the direct scm-schema  ##
-- ## restore (apply-scm-views.mjs pulls 2990's 0050/0053/0054/0095, none of ##
-- ## which are vendored here), so its authoritative body lives only in the  ##
-- ## DB. Houzs CI pg-migrates PROD on every deploy and a failed file blocks  ##
-- ## ALL later migrations, so this MUST be applied to STAGING first          ##
-- ## (ref minnapsemfzjmtvnnvdd, NEVER prod anogrigyjbduyzclzjgn) via the     ##
-- ## Supabase management API and verified before this PR merges — same       ##
-- ## handling as PR #874.                                                    ##
-- ############################################################################
--
-- The view bodies below are byte-faithful to pg_get_viewdef('scm.<view>', true)
-- dumped from STAGING (minnapsemfzjmtvnnvdd, 2026-07-20). Only the company_id
-- additions differ from the dump — see each block. Both are CREATE OR REPLACE
-- (additive, idempotent): every existing output column keeps its name, type and
-- position, and Postgres allows appending a column at the END, so no DROP +
-- CREATE (and no dependent handling) is needed. Nothing else depends on either
-- view.
--
-- Splitter contract (scripts/lib/split-sql.mjs): each statement is a single
-- CREATE OR REPLACE VIEW whose only ";" is at the very end — no dollar-quoted
-- bodies, no internal ";". search_path is pinned to scm so the (fully-qualified)
-- bodies and the appended alias.company_id refs resolve in scm.

SET search_path TO scm, public;

-- 1) v_inventory_all_skus (A3, CONFIRMED live leak) — the "all SKUs incl. zero
--    balance" rollup behind GET /inventory?showAll=true. It CROSS JOINs
--    mfg_products x warehouses with NO company predicate and exposes NO
--    company_id, so a user in one company saw the OTHER company's catalogue,
--    warehouses, on-hand qty, valuation and main supplier (the route
--    deliberately skipped scoping this read because the column did not exist).
--    FIX, mirroring how 0084 scoped inventory_balances:
--      (a) append w.company_id AS company_id (LAST column) so the route can
--          .eq('company_id', <active>) it; and
--      (b) add `p.company_id = w.company_id` to the WHERE so a product is only
--          ever paired with a warehouse of its OWN company. This removes the
--          cross-company pairs at the source (defence in depth) and, with the
--          colliding codes below, stops one company's product row being listed
--          against the other company's warehouse. The inner b/v sub-aggregates
--          already key on warehouse_id (company-unique), so they need no change.
--    An un-companied warehouse (company_id IS NULL — the column is nullable,
--    though 0 exist on staging and the API always stamps it) fails CLOSED here:
--    its rows drop out rather than show to everyone. Row-for-row identical while
--    data is single-company.
CREATE OR REPLACE VIEW scm.v_inventory_all_skus AS
 SELECT p.code AS product_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    w.name AS warehouse_name,
    COALESCE(b.qty, 0::numeric) AS qty,
    b.last_movement_at,
    COALESCE(v.value_sen, 0::bigint) AS value_sen,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_centi AS main_supplier_price_centi,
    w.company_id
   FROM scm.mfg_products p
     CROSS JOIN scm.warehouses w
     LEFT JOIN ( SELECT inventory_balances.warehouse_id,
            inventory_balances.product_code,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.warehouse_id, inventory_balances.product_code) b ON b.warehouse_id = w.id AND b.product_code = p.code
     LEFT JOIN ( SELECT inventory_lots.warehouse_id,
            inventory_lots.product_code,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.warehouse_id, inventory_lots.product_code) v ON v.warehouse_id = w.id AND v.product_code = p.code
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_centi
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.material_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_centi
         LIMIT 1) ms ON true
  WHERE w.is_active = true AND p.status = 'ACTIVE'::scm.mfg_product_status AND p.company_id = w.company_id;

-- 2) v_inventory_product_totals (B1, CONFIRMED real) — the per-product list
--    behind GET /inventory/products. 0106 appended company_id + the route scopes
--    the OUTER read, but 0106's own header flagged that the inner b
--    (inventory_balances) and v (inventory_lots) sub-aggregates GROUP BY
--    product_code ONLY, so total_qty / total_value_sen sum BOTH companies' books
--    whenever a product_code exists in both. That premise ("codes are per-company
--    today, master_codes/0087") is FALSE: 0087 converted products.sku /
--    suppliers.code / warehouses.code, never mfg_products.code, which has only a
--    NON-unique index — and staging already holds 17 shared codes (CODY-(K),
--    FENRIR-(Q), ...). The moment both companies stock a shared code, each
--    company's row shows the COMBINED qty/value. FIX: add company_id to BOTH
--    inner sub-aggregates (SELECT + GROUP BY) and to their join to p, so each
--    product's totals use ONLY its own company's balances/lots. inventory_movements
--    .company_id is NOT NULL (so inventory_balances/inventory_lots never carry a
--    NULL company_id), meaning no stock is dropped by the tightened join. Outer
--    column list is UNCHANGED (company_id already last).
CREATE OR REPLACE VIEW scm.v_inventory_product_totals AS
 SELECT p.code AS product_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    p.base_price_sen,
    p.price1_sen,
    p.branding,
    COALESCE(b.qty, 0::numeric) AS total_qty,
    COALESCE(v.value_sen, 0::bigint) AS total_value_sen,
    b.last_movement_at,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_centi AS main_supplier_price_centi,
    p.company_id
   FROM scm.mfg_products p
     LEFT JOIN ( SELECT inventory_balances.product_code,
            inventory_balances.company_id,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.product_code, inventory_balances.company_id) b ON b.product_code = p.code AND b.company_id = p.company_id
     LEFT JOIN ( SELECT inventory_lots.product_code,
            inventory_lots.company_id,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.product_code, inventory_lots.company_id) v ON v.product_code = p.code AND v.company_id = p.company_id
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_centi
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.material_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_centi
         LIMIT 1) ms ON true
  WHERE p.status = 'ACTIVE'::scm.mfg_product_status;
