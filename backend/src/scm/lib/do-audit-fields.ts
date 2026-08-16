// ----------------------------------------------------------------------------
// do-audit-fields.ts — the Delivery Order's audit vocabulary: which columns are
// auditable, under which camelCase key, and the select that reads them back.
//
// WHY THIS IS NOT IN delivery-orders-mfg.ts ANY MORE. It is pure data with no
// dependency on Hono, the env or the route's helpers, and the route file is a
// standing file-size violation (5,678 lines against a 5,418 ceiling as of
// 2026-08-16) that may only shrink. Moving the vocabulary out is the cheapest
// honest way to add to that file, and it is the same move #2136 made for
// doHasDownstream — asserted by autocountWritebackWiring.test.ts, which checks
// the route IMPORTS that helper rather than defining it.
//
// The camelCase half of every tuple is LOAD-BEARING: AUDIT_FINANCE_FIELDS
// (lib/finance-keys) is keyed on those exact spellings, and stripAuditFinance
// matches them literally, so a cost recorded as 'unit_cost_centi' or 'unitCost'
// sails past the strip and hands the cost basis to every reader of the
// document. The line list's siblings for GRN / SI / PO / PI live in
// entity-audit-fields.ts and are guarded by entityAudit.test.ts for exactly
// this reason; DO's are guarded by doAuditFields.test.ts next to them.
// ----------------------------------------------------------------------------

import type { AuditFieldMap } from './entity-audit-fields';

export type { AuditFieldMap };

/* The auditable DO header fields, camel (API) -> snake (column). Deliberately
   the same list the PATCH's own map uses. */
export const DO_AUDIT_FIELDS: AuditFieldMap = [
  ['debtorCode', 'debtor_code'], ['debtorName', 'debtor_name'], ['agent', 'agent'],
  ['salesLocation', 'sales_location'], ['ref', 'ref'], ['poDocNo', 'po_doc_no'],
  ['venue', 'venue'], ['venueId', 'venue_id'], ['branding', 'branding'],
  ['address1', 'address1'], ['address2', 'address2'],
  ['city', 'city'], ['state', 'state'], ['postcode', 'postcode'], ['phone', 'phone'],
  ['note', 'note'], ['notes', 'notes'],
  ['doDate', 'do_date'], ['currency', 'currency'],
  ['customerState', 'customer_state'], ['customerCountry', 'customer_country'],
  ['customerSoNo', 'customer_so_no'],
  ['customerDeliveryDate', 'customer_delivery_date'],
  ['expectedDeliveryAt', 'expected_delivery_at'],
  ['timeRange', 'time_range'], ['timeConfirmed', 'time_confirmed'],
  ['arrivalAt', 'arrival_at'], ['departureAt', 'departure_at'],
  ['shipoutDate', 'shipout_date'], ['customerDeliveredDate', 'customer_delivered_date'],
  ['etaArrivingPort', 'eta_arriving_port'], ['deliverySubstatus', 'delivery_substatus'],
  ['arrivesEmWarehouseDate', 'arrives_em_warehouse_date'],
  ['email', 'email'], ['customerType', 'customer_type'],
  ['salespersonId', 'salesperson_id'], ['buildingType', 'building_type'],
  ['driverId', 'driver_id'], ['driverName', 'driver_name'], ['vehicle', 'vehicle'],
  ['emergencyContactName', 'emergency_contact_name'],
  ['emergencyContactPhone', 'emergency_contact_phone'],
  ['emergencyContactRelationship', 'emergency_contact_relationship'],
];

export const DO_AUDIT_SELECT =
  `id, do_number, status, company_id, ${DO_AUDIT_FIELDS.map(([, snake]) => snake).join(', ')}`;

/* The auditable LINE fields. The camel names are deliberate: unitCostCenti,
   lineCostCenti and lineMarginCenti are the exact keys AUDIT_FINANCE_FIELDS
   (lib/finance-keys) strips from field_changes, so recording a line's cost here
   is gated on read by the same rule that gates it on the detail payload.
   Spelling one of them differently would leak cost to every reader. */
export const DO_LINE_AUDIT_FIELDS: AuditFieldMap = [
  ['qty', 'qty'],
  ['unitPriceCenti', 'unit_price_centi'],
  ['discountCenti', 'discount_centi'],
  ['unitCostCenti', 'unit_cost_centi'],
  ['lineTotalCenti', 'line_total_centi'],
  ['itemCode', 'item_code'],
  ['itemGroup', 'item_group'],
  ['description', 'description'],
  ['uom', 'uom'],
  ['notes', 'notes'],
  ['rackId', 'rack_id'],
  ['lineDeliveryDate', 'line_delivery_date'],
];
