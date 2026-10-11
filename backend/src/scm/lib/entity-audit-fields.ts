// ----------------------------------------------------------------------------
// entity-audit-fields.ts — the per-document LINE vocabularies for the audit
// trail, plus the PostgREST select string that reads each one back.
//
// WHY THESE LIVE IN lib/ AND NOT IN THEIR ROUTE FILES, unlike the HEADER lists
// (SI_AUDIT_FIELDS, DO_AUDIT_FIELDS, PO_AUDIT_FIELDS, PI_AUDIT_FIELDS):
//
//   1. The camelCase half of each tuple is LOAD-BEARING and needs a test to say
//      so. AUDIT_FINANCE_FIELDS (lib/finance-keys) is keyed on those exact
//      spellings — 'unitCostCenti', 'lineCostCenti', 'lineMarginCenti' — and
//      stripAuditFinance matches them literally. A line recorded as
//      'unit_cost_centi' or 'unitCost' sails straight past the strip and hands
//      the cost basis to every reader who can see the document, which is the
//      #600/#625/#632 shape one endpoint over. Importing a ROUTE file into a
//      test drags in Hono, the auth middleware and the whole scm env; importing
//      this does not, so the spellings can actually be guarded.
//
//   2. The SELECT and the field list must not drift. Every audited column has to
//      be in the select, or the BEFORE half of its from->to pair reads back
//      undefined and diffFields silently records nothing — a field that looks
//      covered and is not. auditSelectCovers() below is the check, and the test
//      runs it over all four documents.
//
// WHY THE SELECTS ARE HAND-WRITTEN LITERALS rather than derived from the tuples:
// supabase-js parses the select STRING at the type level. A string built with
// .map().join() widens to `string`, and every `.select(...)` built that way
// returns ParserError, which turns every downstream property read into a type
// error. Concatenated literals keep the literal type. So the two are written out
// separately and reconciled by the test instead of by construction.
// ----------------------------------------------------------------------------

/** camel (API / audit key) -> snake (column). */
export type AuditFieldMap = Array<[camel: string, snake: string]>;

/* ── GRN line ──────────────────────────────────────────────────────────────
   unit_price_centi is the SUPPLIER's price on a receipt and is deliberately NOT
   a finance-gated key — the same call the already-shipped GRN POST row makes
   when it records totalCenti ungated. unit_cost_centi IS gated, and is spelled
   to match AUDIT_FINANCE_FIELDS. */
export const GRN_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qtyReceived', 'qty_received'],
  ['qtyAccepted', 'qty_accepted'],
  ['qtyRejected', 'qty_rejected'],
  ['rejectionReason', 'rejection_reason'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['materialCode', 'material_code'],
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
  'qty_received, qty_accepted, qty_rejected, rejection_reason, unit_price_centi, ' +
  'discount_centi, unit_cost_centi, line_total_centi, material_code, material_name, ' +
  'supplier_sku, item_group, description, uom, notes, delivery_date, rack_id';

/* ── Sales Invoice line ────────────────────────────────────────────────────
   unitCostCenti / lineCostCenti / lineMarginCenti are the three keys
   AUDIT_FINANCE_FIELDS strips. lineTotalCenti (what the customer is charged) is
   NOT one of them — that is the line #625 drew and this keeps. */
export const SI_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['taxCenti', 'tax_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['lineCostCenti', 'line_cost_centi'],
  ['lineMarginCenti', 'line_margin_centi'],
  ['itemCode', 'item_code'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
];

export const SI_LINE_AUDIT_SELECT =
  'qty, unit_price_centi, discount_centi, tax_centi, unit_cost_centi, ' +
  'line_total_centi, line_cost_centi, line_margin_centi, item_code, item_group, ' +
  'description, uom, notes';

/* ── Purchase Order line ───────────────────────────────────────────────────
   A PO line's unit_price_centi is what we agree to PAY, and unit_cost_centi is
   the cost snapshot — the latter keeps the gated spelling. */
export const PO_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['materialCode', 'material_code'],
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
  'qty, unit_price_centi, discount_centi, unit_cost_centi, line_total_centi, ' +
  'material_code, material_name, supplier_sku, item_group, description, uom, notes, ' +
  'delivery_date, warehouse_id, supplier_delivery_date_2, supplier_delivery_date_3, ' +
  'supplier_delivery_date_4';

/* ── Purchase Invoice line ─────────────────────────────────────────────────
   The PI is what the supplier bills, so unit_price_centi is the billed price.
   unit_cost_centi keeps the gated spelling for the same reason as the PO. */
export const PI_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['materialCode', 'material_code'],
  ['materialName', 'material_name'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
];

export const PI_LINE_AUDIT_SELECT =
  'qty, unit_price_centi, discount_centi, unit_cost_centi, line_total_centi, ' +
  'material_code, material_name, item_group, description, uom, notes';

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
