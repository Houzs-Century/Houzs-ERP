-- Expose scm.mfg_products.barcode on the Inventory Balances list so staff can
-- search a SKU by its AutoCount barcode and see it as a column (cash & carry /
-- bedline items carry one; most make-to-order furniture does not, and shows blank).
-- Additive: `p.barcode` is appended to the END of the view's column list, so
-- CREATE OR REPLACE is enough (no DROP, dependents keep working).
-- REVERSAL: DROP VIEW scm.v_inventory_product_totals; then recreate the body below
--   WITHOUT the trailing `p.barcode` column (i.e. the mig 0307 body). The view
--   carries NO explicit role grants (verified at mig 0307), so none to restore.

BEGIN;

CREATE OR REPLACE VIEW scm.v_inventory_product_totals AS
 SELECT p.code AS item_code,
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
    ms.unit_price_sen AS main_supplier_price_sen,
    p.company_id,
    p.barcode
   FROM scm.mfg_products p
     LEFT JOIN ( SELECT inventory_balances.item_code,
            inventory_balances.company_id,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.item_code, inventory_balances.company_id) b ON b.item_code = p.code AND b.company_id = p.company_id
     LEFT JOIN ( SELECT inventory_lots.item_code,
            inventory_lots.company_id,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.item_code, inventory_lots.company_id) v ON v.item_code = p.code AND v.company_id = p.company_id
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_sen
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.item_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_sen
         LIMIT 1) ms ON true
  WHERE p.status = 'ACTIVE'::scm.mfg_product_status;

COMMIT;
