/* Sales Order audit vocabulary — the keys recordSoAudit / diffFields emit.
   Split out of SalesOrderDetail.tsx when the History drawer became the shared
   AuditHistoryPanel; unmapped keys fall back to humaniseKey, so this list is a
   quality improvement rather than a correctness requirement. */

import type { AuditLabelDictionary } from '../../components/audit/audit-labels';

const ACTIONS: Record<string, string> = {
  CREATE:         'Created order',
  UPDATE_DETAILS: 'Updated details',
  UPDATE_STATUS:  'Status changed',
  ADD_LINE:       'Added line',
  UPDATE_LINE:    'Updated line',
  DELETE_LINE:    'Removed line',
  ADD_PAYMENT:    'Added payment',
  UPDATE_PAYMENT: 'Edited payment',
  DELETE_PAYMENT: 'Removed payment',
};

const FIELDS: Record<string, string> = {
  debtorCode: 'Customer code', debtorName: 'Customer', agent: 'Agent',
  phone: 'Phone', email: 'Email', soDate: 'SO date', status: 'Status',
  paymentMethod: 'Payment method', depositCenti: 'Deposit',
  processingDate: 'Processing date', customerSoNo: 'Customer SO ref',
  customerPo: 'Customer PO', customerState: 'State',
  customerDeliveryDate: 'Delivery date', city: 'City', postcode: 'Postcode',
  buildingType: 'Building type', address1: 'Address 1', address2: 'Address 2',
  address3: 'Address 3', address4: 'Address 4', note: 'Note',
  remark2: 'Remark 2', remark3: 'Remark 3', remark4: 'Remark 4',
  itemCode: 'Item', itemGroup: 'Group', description: 'Description',
  description2: 'Description 2', uom: 'UOM', qty: 'Qty',
  unitPriceCenti: 'Unit price', discountCenti: 'Discount',
  unitCostCenti: 'Unit cost', totalCenti: 'Line total',
  lineCount: 'Lines', localTotalCenti: 'Total', cancelled: 'Cancelled',
  remark: 'Remark', salespersonId: 'Salesperson', customerType: 'Customer type',
  emergencyContactName: 'Emergency name', emergencyContactPhone: 'Emergency phone',
  emergencyContactRelationship: 'Emergency relationship',
  targetDate: 'Target date', branding: 'Branding', venue: 'Venue', venueId: 'Venue (master)',
  salesLocation: 'Sales location', ref: 'Ref', poDocNo: 'PO doc no',
  /* Coverage-audit additions (2026-07) — keys emitted by the DO amend mirror,
     Delivery Planning /fields + /schedule and payment/automation entries. */
  amendDateFromCustomer: 'Amend date (customer)', amendedDeliveryDate: 'Amended delivery date',
  amendReason: 'Amend reason', deliveryState: 'Delivery region',
  possessionDate: 'Possession date', houseType: 'House type',
  replacementDisposal: 'Replacement / disposal', referral: 'Referral',
  amountCenti: 'Amount', paidAt: 'Paid on', method: 'Method',
  merchantProvider: 'Bank', installmentMonths: 'Installment months',
  onlineType: 'Online type', approvalCode: 'Approval code',
  stockStatus: 'Stock status', photoAdded: 'Photo added', photoRemoved: 'Photo removed',
  photosCleaned: 'Photos removed', tbcVariants: 'Variants updated', sofaBuild: 'Sofa build',
  pwpCode: 'PWP code', pwpRewardsReverted: 'PWP rewards reverted', pwpCodesDeleted: 'PWP codes deleted',
  /* Emitted by POST /:docNo/payments/:id/slip (2026-08-07) — the after-the-fact
     proof attach. from=null reads as an attach, from=<key> as a replacement. */
  slipKey: 'Payment proof',
};

const MONEY_FIELDS = new Set([
  'unitPriceCenti', 'discountCenti', 'totalCenti', 'depositCenti',
  'localTotalCenti', 'unitCostCenti', 'amountCenti',
]);

export const SO_AUDIT_LABELS: AuditLabelDictionary = {
  actions: ACTIONS,
  fields: FIELDS,
  moneyFields: MONEY_FIELDS,
};
