const LABELS: Record<string, string> = {
  'mfg_products.code': 'SKUs',
  'mfg_sales_order_items.item_code': 'sales order lines',
  'mfg_so_price_overrides.item_code': 'SO price overrides',
  'delivery_order_items.item_code': 'delivery order lines',
  'delivery_return_items.item_code': 'delivery return lines',
  'sales_invoice_items.item_code': 'sales invoice lines',
  'purchase_order_items.item_code': 'PO lines',
  'grn_items.item_code': 'GRN lines',
  'purchase_invoice_items.item_code': 'purchase invoice lines',
  'purchase_return_items.item_code': 'purchase return lines',
  'supplier_material_bindings.item_code': 'supplier bindings',
  'inventory_movements.item_code': 'stock movements',
  'inventory_balances.item_code': 'stock balances',
  'inventory_lots.item_code': 'stock lots',
  'pos_sofa_combos.modules': 'POS combos',
  maintenance_config_history: 'maintenance configs',
  product_models: 'Models',
  sofa_combo_pricing: 'combos',
  sofa_quick_picks: 'quick picks',
};

/** "14 SKUs, 41 sales order lines" from a rename preview's count map; zero rows are left out. */
export function describeRenameCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${LABELS[key] ?? key}`)
    .join(', ');
}
