
import type { AuditLabelDictionary } from '../../components/audit/audit-labels';


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
  notes: 'Remark', lineDescription: 'Line description', currency: 'Currency', exchangeRate: 'Exchange rate',
  payToBankName: 'Bank', payToAccountNo: 'Account no.', payToAccountName: 'Account name',
  fileRemoved: 'File removed',
  totalSen: 'Total', allocatedSen: 'Allocated to invoices', bankChargeSen: 'Bank charges',
  lineCount: 'Lines', jeNo: 'GL entry no', postedTotalSen: 'Posted total',
  reversalJeNo: 'Reversal GL entry no', reversalOk: 'Reversal succeeded',
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
  moneyFields: new Set(['totalSen', 'allocatedSen', 'postedTotalSen', 'appliedSen', 'bankChargeSen']),
};


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


const STOCK_TAKE_ACTIONS: Record<string, string> = {
  CREATE:              'Created stock take',
  UPDATE:              'Updated counts',
  POST:                'Posted stock take',
  SUBMIT_FOR_APPROVAL: 'Sent for approval',
  APPROVE:             'Approved and posted',
  REJECT:              'Returned for recount',
  CANCEL:              'Cancelled stock take',
  REVERSE:             'Reversed posting',
  DELETE:              'Deleted stock take',
};

const STOCK_TAKE_FIELDS: Record<string, string> = {
  status: 'Status', warehouseId: 'Warehouse', takeNo: 'Take no',
  movementsReversed: 'Movements reversed', netQtyReversed: 'Net qty reversed',
};

const stockTakeFieldLabel = (field: string): string | undefined => (
  /^[a-z][A-Za-z0-9]*$/.test(field) ? undefined : field
);

export const STOCK_TAKE_AUDIT_LABELS: AuditLabelDictionary = {
  actions: STOCK_TAKE_ACTIONS,
  fields: STOCK_TAKE_FIELDS,
  fallbackFieldLabel: stockTakeFieldLabel,
};


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

export const STOCK_TRANSFER_AUDIT_LABELS: AuditLabelDictionary = {
  actions: STOCK_TRANSFER_ACTIONS,
  fields: STOCK_TRANSFER_FIELDS,
};


const STOCK_ADJUSTMENT_ACTIONS: Record<string, string> = {
  CREATE: 'Created adjustment',
  UPDATE: 'Edited adjustment',
};

const STOCK_ADJUSTMENT_FIELDS: Record<string, string> = {
  warehouseId: 'Warehouse', lines: 'Lines', lineCount: 'Line count', netQty: 'Net qty',
  notes: 'Notes', itemCode: 'SKU', variantKey: 'Variant', batchNo: 'Batch',
  qtyDelta: 'Qty', reasonCode: 'Reason',
};

export const STOCK_ADJUSTMENT_AUDIT_LABELS: AuditLabelDictionary = {
  actions: STOCK_ADJUSTMENT_ACTIONS,
  fields: { ...STOCK_ADJUSTMENT_FIELDS, unitCostSen: 'Unit cost' },
  moneyFields: new Set(['unitCostSen']),
};
