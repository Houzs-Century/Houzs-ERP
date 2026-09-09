/* Audit vocabularies for the four documents recorded in scm.entity_audit_log.
   Same shape and purpose as so-audit-labels.ts: unmapped keys fall back to
   humaniseKey, so each dictionary is a quality improvement rather than a
   correctness requirement.

   Every key below was taken from an actual recordEntityAudit call site in
   backend/src/scm/routes/*, not from a table definition — the differ emits the
   CAMEL half of its alias tuples (lib/so-audit.diffFields), so these are
   camelCase and never raw column names.

   Money in this codebase is INTEGER SEN. The panel renders a key through
   fmtSen only if it appears in moneyFields, so a money key omitted here shows
   as a bare integer (RM 1,234.00 would read as "123400"). */

import type { AuditLabelDictionary } from '../../components/audit/audit-labels';

/* ── Payment Voucher — routes/payment-vouchers.ts ─────────────────────────── */

const PV_ACTIONS: Record<string, string> = {
  CREATE:  'Created voucher',
  UPDATE:  'Updated details',
  POST:    'Posted to GL',
  CANCEL:  'Cancelled voucher',
  REVERSE: 'Reversed GL entry',
  DELETE:  'Deleted voucher',
};

const PV_FIELDS: Record<string, string> = {
  status: 'Status', payeeName: 'Payee', creditAccountCode: 'Credit account',
  voucherDate: 'Voucher date', supplierId: 'Supplier', purpose: 'Type',
  notes: 'Notes', currency: 'Currency', exchangeRate: 'Exchange rate',
  totalSen: 'Total', allocatedSen: 'Allocated to invoices',
  lineCount: 'Lines', jeNo: 'GL entry no', postedTotalSen: 'Posted total',
  reversalJeNo: 'Reversal GL entry no', reversalOk: 'Reversal succeeded',
  /* 2026-07-30 — "the payment defines the FX rate". A knock-off writes its rate onto
     an un-rated foreign invoice and re-costs that invoice's GRN; a rate that
     disagrees with one already entered is reported, never overwritten. Cancelling
     the voucher RETAINS the rate (reverting would restore the 1:1 mis-cost). */
  fxRateAdoptedOnPi: 'Exchange rate set on invoice',
  fxRateMismatchOnPi: 'Invoice rate differs (kept)',
  fxRateRetainedFromPv: 'Exchange rate kept from voucher',
  exchangeRateRetained: 'Exchange rate retained',
  rateSourcePv: 'Rate taken from voucher',
  appliedSen: 'Applied to invoice',
};

export const PAYMENT_VOUCHER_AUDIT_LABELS: AuditLabelDictionary = {
  actions: PV_ACTIONS,
  fields: PV_FIELDS,
  moneyFields: new Set(['totalSen', 'allocatedSen', 'postedTotalSen', 'appliedSen']),
};

/* ── GRN — routes/grns.ts ─────────────────────────────────────────────────── */

/* Only POST and CANCEL are written today: the GRN create path records nothing,
   so a receipt's history starts at the moment it was posted. The other verbs are
   labelled anyway so a later write-side addition reads correctly on day one. */
const GRN_ACTIONS: Record<string, string> = {
  CREATE:  'Created GRN',
  UPDATE:  'Updated details',
  POST:    'Posted receipt',
  CANCEL:  'Cancelled GRN',
  REVERSE: 'Reversed receipt',
  DELETE:  'Deleted GRN',
};

const GRN_FIELDS: Record<string, string> = {
  status: 'Status', warehouseId: 'Warehouse', totalSen: 'Total',
  lineCount: 'Lines', qtyReversed: 'Qty reversed',
};

export const GRN_AUDIT_LABELS: AuditLabelDictionary = {
  actions: GRN_ACTIONS,
  fields: GRN_FIELDS,
  moneyFields: new Set(['totalSen']),
};

/* ── Stock Take — routes/stock-takes.ts ───────────────────────────────────── */

const STOCK_TAKE_ACTIONS: Record<string, string> = {
  CREATE:  'Created stock take',
  UPDATE:  'Updated counts',
  POST:    'Posted stock take',
  CANCEL:  'Cancelled stock take',
  REVERSE: 'Reversed posting',
  DELETE:  'Deleted stock take',
};

const STOCK_TAKE_FIELDS: Record<string, string> = {
  status: 'Status', warehouseId: 'Warehouse', takeNo: 'Take no',
  movementsReversed: 'Movements reversed', netQtyReversed: 'Net qty reversed',
};

/* UPDATE and POST write one change per SKU, keyed by the product code (and by
   the line UUID when the before-row lookup missed). Those keys are data, so they
   must render verbatim. Every key the backend AUTHORS is lowerCamelCase, which
   makes "not lowerCamelCase" a reliable test for "this is a code, not a field
   name" — anything that looks authored still falls through to humaniseKey. */
const stockTakeFieldLabel = (field: string): string | undefined => (
  /^[a-z][A-Za-z0-9]*$/.test(field) ? undefined : field
);

/* No moneyFields: every stock-take value is a counted quantity. */
export const STOCK_TAKE_AUDIT_LABELS: AuditLabelDictionary = {
  actions: STOCK_TAKE_ACTIONS,
  fields: STOCK_TAKE_FIELDS,
  fallbackFieldLabel: stockTakeFieldLabel,
};

/* ── Stock Transfer — routes/stock-transfers.ts ───────────────────────────── */

const STOCK_TRANSFER_ACTIONS: Record<string, string> = {
  CREATE:  'Created transfer',
  UPDATE:  'Updated details',
  POST:    'Posted transfer',
  CANCEL:  'Cancelled transfer',
  REVERSE: 'Reversed transfer',
  DELETE:  'Deleted transfer',
};

const STOCK_TRANSFER_FIELDS: Record<string, string> = {
  status: 'Status', fromWarehouseId: 'From warehouse', toWarehouseId: 'To warehouse',
  transferDate: 'Transfer date', lineCount: 'Lines', totalQty: 'Total qty',
  notes: 'Notes', movementsReversed: 'Movements reversed',
  movementsSkipped: 'Movements skipped', movementsFailed: 'Movements failed',
};

/* No moneyFields: totalQty and the movements* keys are counts. */
export const STOCK_TRANSFER_AUDIT_LABELS: AuditLabelDictionary = {
  actions: STOCK_TRANSFER_ACTIONS,
  fields: STOCK_TRANSFER_FIELDS,
};
