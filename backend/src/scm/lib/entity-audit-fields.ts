
/** camel (API / audit key) -> snake (column). */
export type AuditFieldMap = Array<[camel: string, snake: string]>;

export const GRN_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qtyReceived', 'qty_received'],
  ['qtyAccepted', 'qty_accepted'],
  ['qtyRejected', 'qty_rejected'],
  ['rejectionReason', 'rejection_reason'],
  ['unitPriceSen', 'unit_price_sen'],
  ['discountSen', 'discount_sen'],
  ['unitCostSen', 'unit_cost_sen'],
  ['lineTotalSen', 'line_total_sen'],
  ['itemCode', 'item_code'],
  ['materialName', 'material_name'],
  ['supplierSku', 'supplier_sku'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
  ['deliveryDate', 'delivery_date'],
  ['rackId', 'rack_id'],
];

export const GRN_LINE_AUDIT_SELECT =
  'qty_received, qty_accepted, qty_rejected, rejection_reason, unit_price_sen, ' +
  'discount_sen, unit_cost_sen, line_total_sen, item_code, material_name, ' +
  'supplier_sku, item_group, description, uom, notes, delivery_date, rack_id';

export const SI_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceSen', 'unit_price_sen'],
  ['discountSen', 'discount_sen'],
  ['taxSen', 'tax_sen'],
  ['unitCostSen', 'unit_cost_sen'],
  ['lineTotalSen', 'line_total_sen'],
  ['lineCostSen', 'line_cost_sen'],
  ['lineMarginSen', 'line_margin_sen'],
  ['itemCode', 'item_code'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
];

export const SI_LINE_AUDIT_SELECT =
  'qty, unit_price_sen, discount_sen, tax_sen, unit_cost_sen, ' +
  'line_total_sen, line_cost_sen, line_margin_sen, item_code, item_group, ' +
  'description, uom, notes';

export const PO_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceSen', 'unit_price_sen'],
  ['discountSen', 'discount_sen'],
  ['unitCostSen', 'unit_cost_sen'],
  ['lineTotalSen', 'line_total_sen'],
  ['itemCode', 'item_code'],
  ['materialName', 'material_name'],
  ['supplierSku', 'supplier_sku'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
  ['deliveryDate', 'delivery_date'],
  ['warehouseId', 'warehouse_id'],
  ['supplierDeliveryDate2', 'supplier_delivery_date_2'],
  ['supplierDeliveryDate3', 'supplier_delivery_date_3'],
  ['supplierDeliveryDate4', 'supplier_delivery_date_4'],
];

export const PO_LINE_AUDIT_SELECT =
  'qty, unit_price_sen, discount_sen, unit_cost_sen, line_total_sen, ' +
  'item_code, material_name, supplier_sku, item_group, description, uom, notes, ' +
  'delivery_date, warehouse_id, supplier_delivery_date_2, supplier_delivery_date_3, ' +
  'supplier_delivery_date_4';

export const PI_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceSen', 'unit_price_sen'],
  ['discountSen', 'discount_sen'],
  ['unitCostSen', 'unit_cost_sen'],
  ['lineTotalSen', 'line_total_sen'],
  ['itemCode', 'item_code'],
  ['materialName', 'material_name'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
];

export const PI_LINE_AUDIT_SELECT =
  'qty, unit_price_sen, discount_sen, unit_cost_sen, line_total_sen, ' +
  'item_code, material_name, item_group, description, uom, notes';

/**
 * Which audited columns are MISSING from a select string — empty means covered.
 *
 * Returns the gap rather than a boolean so a failure names the column instead of
 * just saying no. Splits on commas and trims, which is exactly how PostgREST
 * reads the string; embedded-resource syntax (`po:purchase_orders(...)`) is not
 * used by any of the selects here, so the naive split is the right one.
 */
export function auditSelectGaps(fields: AuditFieldMap, select: string): string[] {
  const present = new Set(select.split(',').map((s) => s.trim()));
  return fields.map(([, snake]) => snake).filter((snake) => !present.has(snake));
}
