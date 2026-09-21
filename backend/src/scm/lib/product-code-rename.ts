/* Where a SKU's code lives, and which of those places follow a rename.
 *
 * The code is snapshotted as TEXT across the ERP with no foreign key, so
 * PATCH /mfg-products/:id (scm/routes/mfg-products.ts) re-points every column in
 * PRODUCT_CODE_CASCADE, scoped to the active company. Every other column that is
 * named like a product code is in PRODUCT_CODE_KEEPS_VALUE with the reason it must
 * NOT follow. backend/tests/productCodeRenameCoverage.test.ts fails when a
 * code-bearing column on production (tests/fixtures/product-code-columns.snapshot.json)
 * or in a newer migration is in neither list. Guide: docs/modules/product-code-rename.md. */

export interface CascadeColumn {
  table: string;
  col: string;
  /** The table also stores fabrics and raw materials: rename only material_kind = 'mfg_product'. */
  kind?: true;
}

/* All in schema scm (the route's client), every one carrying company_id. */
export const PRODUCT_CODE_CASCADE: readonly CascadeColumn[] = [
  { table: 'supplier_material_bindings', col: 'item_code', kind: true },
  { table: 'purchase_order_items',       col: 'item_code', kind: true },
  { table: 'grn_items',                  col: 'item_code', kind: true },
  { table: 'purchase_invoice_items',     col: 'item_code', kind: true },
  { table: 'purchase_return_items',      col: 'item_code', kind: true },
  { table: 'purchase_consignment_order_items',   col: 'item_code', kind: true },
  { table: 'purchase_consignment_receive_items', col: 'item_code', kind: true },
  { table: 'purchase_consignment_return_items',  col: 'item_code', kind: true },
  { table: 'mfg_sales_order_items',      col: 'item_code' },
  { table: 'mfg_so_price_overrides',     col: 'item_code' },
  { table: 'delivery_order_items',       col: 'item_code' },
  { table: 'sales_invoice_items',        col: 'item_code' },
  { table: 'delivery_return_items',      col: 'item_code' },
  { table: 'consignment_sales_order_items',     col: 'item_code' },
  { table: 'consignment_delivery_order_items',  col: 'item_code' },
  { table: 'consignment_delivery_return_items', col: 'item_code' },
  /* An amendment's proposed code is applied onto the line later; a pending one
     left on the old code would write a code that no longer exists. */
  { table: 'so_amendment_lines',         col: 'new_item_code' },
  { table: 'po_amendment_lines',         col: 'new_item_code' },
  { table: 'pwp_codes',                  col: 'trigger_item_code' },
  { table: 'pwp_codes',                  col: 'redeemed_item_code' },
  /* A service add-on names the SVC-* SKU the order line is booked under. */
  { table: 'addons',                     col: 'service_sku' },
  { table: 'hr_item_kpi',                col: 'ref' },
  { table: 'product_dept_configs',       col: 'item_code' },
  { table: 'master_price_history',       col: 'item_code' },
  /* Effective-dated selling price (0187): the as-of resolver reads it by code. */
  { table: 'mfg_product_price_history',  col: 'item_code' },
  /* Effective-dated COST history (auto-derive stage 3a): supplier cost history
     (per material_kind) and the derived product-cost history, both read by code. */
  { table: 'supplier_binding_price_history', col: 'item_code', kind: true },
  { table: 'mfg_product_cost_history',   col: 'item_code' },
  { table: 'inventory_movements',        col: 'item_code' },
  { table: 'inventory_lots',             col: 'item_code' },
  { table: 'inventory_lot_consumptions', col: 'item_code' },
  { table: 'stock_transfer_lines',       col: 'item_code' },
  { table: 'stock_take_lines',           col: 'item_code' },
  { table: 'warehouse_rack_items',       col: 'item_code' },
  { table: 'warehouse_rack_movements',   col: 'item_code' },
];

export interface KeptColumn {
  /** schema.table.column */
  column: string;
  why: string;
}

const PRE_SCM_COPY =
  'pre-SCM copy of an scm table left in the public schema: no company_id, no reader in backend/src, '
  + 'and EMPTY (0 rows, read-only run 34970682915, 2026-09-15)';
const AUTOCOUNT = 'names the item in AutoCount, which keeps its own code when the ERP renames';
const SUPPLIER = "the supplier's own model code for our item, not ours";

export const PRODUCT_CODE_KEEPS_VALUE: readonly KeptColumn[] = [
  { column: 'scm.mfg_so_item_deletions.item_code', why: 'forensic record of a deleted SO line as it was at the moment of deletion (0302)' },
  { column: 'scm.retail_price_guard_log.item_code', why: 'evidence of one intervention: the SKU as the offending writer named it, at that moment (20260920T1300)' },
  { column: 'scm.supplier_material_bindings.ac_item_code', why: AUTOCOUNT },
  { column: 'scm.supplier_material_bindings.supplier_sku', why: SUPPLIER },
  { column: 'scm.purchase_order_items.supplier_sku', why: SUPPLIER },
  { column: 'scm.grn_items.supplier_sku', why: SUPPLIER },
  { column: 'scm.purchase_consignment_order_items.supplier_sku', why: SUPPLIER },
  { column: 'scm.purchase_consignment_receive_items.supplier_sku', why: SUPPLIER },
  { column: 'scm.product_models.model_code', why: "a MODEL's own code, a different entity; a SKU rename leaves its model alone" },
  { column: 'scm.products.model_code', why: 'the POS retail catalogue (scm.products), its own key, not mfg_products' },
  { column: 'scm.products.sku', why: 'the POS retail catalogue (scm.products), its own key, not mfg_products' },
  { column: 'scm.purchase_order_lines.sku', why: 'retail order -> supplier PO lines keyed by the scm.products catalogue, not mfg_products' },
  { column: 'public.assr_cases.item_code', why: `service case: ${AUTOCOUNT}; its cost suggestion matches AutoCount's own lines` },
  { column: 'public.assr_items.item_code', why: `service case item: ${AUTOCOUNT}` },
  { column: 'public.purchase_orders.item_code', why: `AutoCount outstanding-PO snapshot: ${AUTOCOUNT}` },
  { column: 'public.stock_items.item_code', why: `AutoCount StockItem cache (services/stockItems.ts): ${AUTOCOUNT}` },
  { column: 'public.sales_entry_items.item_code', why: 'legacy Sales Entry module: typed text, not a link to mfg_products' },
  { column: 'public.project_defects.item_code', why: 'project defect report: typed text, not a link to mfg_products' },
  ...[
    'public.addons.service_sku',
    'public.consignment_delivery_order_items.item_code',
    'public.consignment_delivery_return_items.item_code',
    'public.consignment_sales_order_items.item_code',
    'public.delivery_order_items.item_code',
    'public.delivery_return_items.item_code',
    'public.grn_items.material_code',
    'public.grn_items.supplier_sku',
    'public.inventory_lot_consumptions.product_code',
    'public.inventory_lots.product_code',
    'public.inventory_movements.product_code',
    'public.master_price_history.product_code',
    'public.mfg_purchase_order_items.material_code',
    'public.mfg_purchase_order_items.supplier_sku',
    'public.mfg_purchase_order_lines.sku',
    'public.mfg_sales_order_items.item_code',
    'public.mfg_so_price_overrides.item_code',
    'public.product_dept_configs.product_code',
    'public.product_models.model_code',
    'public.products.model_code',
    'public.products.sku',
    'public.purchase_consignment_receive_items.material_code',
    'public.purchase_consignment_receive_items.supplier_sku',
    'public.purchase_consignment_return_items.material_code',
    'public.purchase_invoice_items.material_code',
    'public.purchase_return_items.material_code',
    'public.pwp_codes.redeemed_item_code',
    'public.pwp_codes.trigger_item_code',
    'public.sales_invoice_items.item_code',
    'public.stock_take_lines.product_code',
    'public.stock_transfer_lines.product_code',
    'public.supplier_material_bindings.material_code',
    'public.supplier_material_bindings.supplier_sku',
    'public.warehouse_rack_items.product_code',
    'public.warehouse_rack_movements.product_code',
  ].map((column) => ({ column, why: PRE_SCM_COPY })),
];
