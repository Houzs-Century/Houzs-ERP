/* Audit vocabularies for the four DOCUMENTS — purchase order, purchase invoice,
   sales invoice, delivery order — whose change history became readable on
   2026-09-13. Same shape and purpose as entity-audit-labels.ts, in its own file
   because that one is already the four money/stock records and this is the
   owner's 2026-09-12 ruling that every document must carry a change log.

   Every key below was taken from a real recordEntityAudit call site, or from the
   alias tuples those call sites diff through — PO_AUDIT_FIELDS and
   PO_LINE_AUDIT_FIELDS for the purchase order, and the matching pairs for the
   other three — never from a table definition. The differ emits the CAMEL half
   of each tuple, so these are camelCase and never raw column names.

   LINE changes arrive under the SAME keys as header changes: the backend writes
   one entry per edited line with the line's identity in the entry NOTE ("Line
   edited: HZ-SOFA-01"), not in the field name. So one dictionary per document
   covers both, and qty / unitPriceSen need no per-line variant.

   Money in this codebase is INTEGER SEN. A money key renders through fmtSen
   only if it appears in moneyFields — omit one and RM 1,234.00 reads as
   "123400". */

import type { AuditLabelDictionary } from '../../components/audit/audit-labels';

/* Shared by all four: every document line carries the same commercial columns,
   and spelling them out four times is how two of them end up disagreeing. */
const LINE_FIELDS: Record<string, string> = {
  qty: 'Quantity', unitPriceSen: 'Unit price', discountSen: 'Discount',
  unitCostSen: 'Unit cost', lineTotalSen: 'Line total',
  itemCode: 'Item code', itemGroup: 'Item group', materialName: 'Material',
  supplierSku: 'Supplier SKU', description: 'Description', uom: 'UOM',
  notes: 'Remark', deliveryDate: 'Line delivery date',
  lineDeliveryDate: 'Line delivery date', warehouseId: 'Warehouse',
  rackId: 'Rack', taxSen: 'Tax', lineCostSen: 'Line cost',
  lineMarginSen: 'Line margin',
};

const LINE_MONEY = [
  'unitPriceSen', 'discountSen', 'unitCostSen', 'lineTotalSen',
  'taxSen', 'lineCostSen', 'lineMarginSen',
];

/* The customer-address block the delivery order and the sales invoice both
   inherit from the sales order. */
const CUSTOMER_FIELDS: Record<string, string> = {
  debtorCode: 'Customer code', debtorName: 'Customer', agent: 'Agent',
  salesLocation: 'Sales location', ref: 'Reference', poDocNo: 'Customer PO no',
  venue: 'Venue', venueId: 'Venue', branding: 'Branding',
  address1: 'Address line 1', address2: 'Address line 2',
  city: 'City', state: 'State', postcode: 'Postcode', phone: 'Phone',
  email: 'Email', customerType: 'Customer type',
  customerState: 'Customer state', customerCountry: 'Customer country',
  customerSoNo: 'Customer SO no', buildingType: 'Building type',
  salespersonId: 'Salesperson', note: 'Note', notes: 'Remark',
  customerDeliveryDate: 'Customer delivery date',
  emergencyContactName: 'Emergency contact',
  emergencyContactPhone: 'Emergency contact phone',
  emergencyContactRelationship: 'Emergency contact relationship',
};

/* ── Purchase Order — routes/mfg-purchase-orders.ts ───────────────────────── */

/* SEND is the verb no other document here uses: it records that the PO was
   EMAILED to its supplier, which is the one event in this log that leaves the
   building. */
const PO_ACTIONS: Record<string, string> = {
  CREATE:  'Created purchase order',
  UPDATE:  'Updated',
  POST:    'Confirmed purchase order',
  SEND:    'Emailed to supplier',
  CANCEL:  'Cancelled purchase order',
  REVERSE: 'Reversed',
  DELETE:  'Deleted purchase order',
};

const PO_FIELDS: Record<string, string> = {
  ...LINE_FIELDS,
  status: 'Status', poDate: 'PO date', expectedAt: 'Expected date',
  currency: 'Currency', notes: 'Remark', supplierId: 'Supplier',
  purchaseLocationId: 'Purchase location',
  supplierDeliveryDate2: 'Supplier delivery date 2',
  supplierDeliveryDate3: 'Supplier delivery date 3',
  supplierDeliveryDate4: 'Supplier delivery date 4',
  emailStatus: 'Email', emailTo: 'Emailed to', emailError: 'Email error',
  totalSen: 'Total', lineCount: 'Lines',
};

export const PURCHASE_ORDER_AUDIT_LABELS: AuditLabelDictionary = {
  actions: PO_ACTIONS,
  fields: PO_FIELDS,
  moneyFields: new Set([...LINE_MONEY, 'totalSen']),
};

/* ── Purchase Invoice — routes/purchase-invoices.ts ───────────────────────── */

const PI_ACTIONS: Record<string, string> = {
  CREATE:  'Created purchase invoice',
  UPDATE:  'Updated',
  POST:    'Posted to AP',
  CANCEL:  'Cancelled purchase invoice',
  REVERSE: 'Reversed AP entry',
  DELETE:  'Deleted purchase invoice',
};

const PI_FIELDS: Record<string, string> = {
  ...LINE_FIELDS,
  status: 'Status', supplierId: 'Supplier',
  supplierInvoiceRef: 'Supplier invoice no',
  invoiceDate: 'Invoice date', dueDate: 'Due date',
  currency: 'Currency', exchangeRate: 'Exchange rate', notes: 'Remark',
  totalSen: 'Total', lineCount: 'Lines',
  /* Written by the POST path, which records whether the AP/GL leg succeeded
     separately from the status change — a post can move the invoice and still
     fail to reach the ledger. */
  apPosted: 'Posted to AP ledger', reversalOk: 'AP reversal succeeded',
};

export const PURCHASE_INVOICE_AUDIT_LABELS: AuditLabelDictionary = {
  actions: PI_ACTIONS,
  fields: PI_FIELDS,
  moneyFields: new Set([...LINE_MONEY, 'totalSen']),
};

/* ── Sales Invoice — routes/sales-invoices.ts ─────────────────────────────── */

const SI_ACTIONS: Record<string, string> = {
  CREATE:  'Created invoice',
  UPDATE:  'Updated',
  POST:    'Issued invoice',
  CANCEL:  'Cancelled invoice',
  REVERSE: 'Reversed AR entry',
  DELETE:  'Deleted invoice',
};

const SI_FIELDS: Record<string, string> = {
  ...LINE_FIELDS,
  ...CUSTOMER_FIELDS,
  status: 'Status', invoiceDate: 'Invoice date', dueDate: 'Due date',
  currency: 'Currency', totalSen: 'Total', lineCount: 'Lines',
  paidSen: 'Paid', balanceSen: 'Balance',
};

export const SALES_INVOICE_AUDIT_LABELS: AuditLabelDictionary = {
  actions: SI_ACTIONS,
  fields: SI_FIELDS,
  moneyFields: new Set([...LINE_MONEY, 'totalSen', 'paidSen', 'balanceSen']),
};

/* ── Delivery Order — routes/delivery-orders-mfg.ts ───────────────────────── */

/* The DO keeps its own vocabulary — the owner's 2026-09-12 exception to the
   SUBMITTED rename — so POST is labelled in the delivery order's words rather
   than the shared ones.

   THE WORD FOR THE STORED VALUE `DISPATCHED` IS "Loaded". The goods going ON
   the lorry is not the lorry leaving; departure is the driver's next scan
   (IN_TRANSIT). Settled 2026-08-26 and pinned tree-wide by
   doDispatchedReadsLoaded.test.ts, which caught this dictionary's first draft
   calling it "Dispatched". */
const DO_ACTIONS: Record<string, string> = {
  CREATE:  'Created delivery order',
  UPDATE:  'Updated',
  POST:    'Loaded onto lorry',
  CANCEL:  'Cancelled delivery order',
  REVERSE: 'Reversed loading',
  DELETE:  'Deleted delivery order',
};

const DO_FIELDS: Record<string, string> = {
  ...LINE_FIELDS,
  ...CUSTOMER_FIELDS,
  status: 'Status', doDate: 'DO date', currency: 'Currency',
  expectedDeliveryAt: 'Expected delivery',
  timeRange: 'Delivery time', timeConfirmed: 'Time confirmed',
  arrivalAt: 'Arrived at', departureAt: 'Departed at',
  shipoutDate: 'Ship-out date', customerDeliveredDate: 'Delivered on',
  etaArrivingPort: 'ETA arriving port', deliverySubstatus: 'Delivery sub-status',
  arrivesEmWarehouseDate: 'Arrives at warehouse',
  driverId: 'Driver', driverName: 'Driver', vehicle: 'Vehicle',
  totalSen: 'Total', lineCount: 'Lines',
};

export const DELIVERY_ORDER_AUDIT_LABELS: AuditLabelDictionary = {
  actions: DO_ACTIONS,
  fields: DO_FIELDS,
  moneyFields: new Set([...LINE_MONEY, 'totalSen']),
};
