/* The Sales Order LINE values — what one line of a sales order shows and
   exports, owner 2026-09-15.

   The SO list's ONE Export follows the grid: one row per SO line, the columns
   the operator has visible, in their order, under their labels (DataTable
   `exportLines`). The labels are AutoCount's own captions, read out of the saved
   grid layouts of the live book (table Layout, form
   FormSalesOrderPrintDetailListing; where two AutoCount listings caption one
   field differently, the Detail Listing's caption is used). The server's line
   shape is named here too, so the list endpoint and the export agree on every
   name.

   THE LABELS ARE AN IMPORT CONTRACT for a future SO line import, which reads a
   file back by header name and matches rows by Line ID.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/so-line-export-columns.ts.
   Refereed by frontend/src/vendor/scm/lib/so-line-export-columns.canonical.test.ts
   and backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

/** The grid's column labels. `SO_DEFAULT_COLUMNS` names the AutoCount layout
 *  the grid opens with; the rest are what the chooser offers. */
export const SO_LABELS = {
  /* Header — AutoCount captions. */
  docNo: 'Doc. No.',
  date: 'Date',
  ref: 'Ref.',
  agent: 'Agent',
  debtorCode: 'Debtor Code',
  debtorName: 'Debtor Name',
  branding: 'BRANDING',
  currency: 'Curr. Code',
  total: 'Total',
  localTotal: 'Local Total',
  balance: 'BALANCE',
  processingDate: 'Processing Date',
  salesExemptionExpiryDate: 'Sales Exemption Expiry Date',
  venue: 'VENUE',
  remark2: 'Remark 2',
  remark4: 'Remark 4',
  note: 'Note',
  phone: 'Phone',
  cancelled: 'Cancelled',
  payment: 'PAYEMENT',
  /* Line — AutoCount captions. */
  itemGroup: 'Item Group',
  itemCode: 'Item Code',
  detailDescription: 'Detail Description',
  detailDescription2: 'Detail Description 2',
  uom: 'UOM',
  location: 'Location',
  qty: 'Qty',
  unitPrice: 'Unit Price',
  discount: 'Discount',
  lineTotal: 'Total (Inc)',
  deliveryDate: 'Delivery Date',
  poDocNo: 'PO Doc No.',
  /* Line — the ERP's own, no AutoCount caption. */
  deliveredQty: 'Delivered Qty',
  returnedQty: 'Returned Qty',
  remainingQty: 'Remaining Qty',
  onDeliveryOrderQty: 'On Delivery Order Qty',
  stockStatus: 'Stock Status',
  doNo: 'DO No.',
  poDeliveryDate: 'PO Delivery Date',
  remarks: 'Remarks',
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  lineId: 'Line ID',
} as const;

/** AutoCount layout "SALES ORDER DETAILS-SALES" (owner 2026-09-15: the SO list's
 *  default), in AutoCount's order. The grid opens with these columns visible. */
export const SO_DEFAULT_COLUMNS = [
  SO_LABELS.date, SO_LABELS.docNo, SO_LABELS.ref, SO_LABELS.agent, SO_LABELS.debtorName, SO_LABELS.branding,
  SO_LABELS.currency, SO_LABELS.total, SO_LABELS.location, SO_LABELS.balance, SO_LABELS.processingDate,
  SO_LABELS.salesExemptionExpiryDate, SO_LABELS.itemGroup, SO_LABELS.itemCode, SO_LABELS.detailDescription,
  SO_LABELS.detailDescription2, SO_LABELS.uom, SO_LABELS.unitPrice, SO_LABELS.qty, SO_LABELS.venue,
] as const;

/** One SO line as the list endpoint and the export send it. Money stays in sen
 *  on the wire; the grid converts at the cell (`senToRinggit`). Where the order is
 *  in AutoCount, the item fields are spelled as the book holds them. */
export type SoListLine = {
  id: string;
  line_no: number | null;
  item_code: string | null;
  erp_item_code: string | null;
  description: string | null;
  description2: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  qty: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  total_sen: number | null;
  delivery_date: string | null;
  remark: string | null;
  stock_status: string | null;
  delivered_qty: number | null;
  returned_qty: number | null;
  remaining_qty: number | null;
  on_delivery_order_qty: number;
  do_nos: string[];
  po_nos: string[];
  po_delivery_date: string | null;
};

/** The order's header values as AutoCount holds them, stamped on the row beside
 *  the ERP's own. For an order that is not in AutoCount (2990) these are the
 *  ERP's own values. */
export type SoBookHeader = {
  ac_doc_no: string | null;
  ac_debtor_code: string | null;
  ac_agent: string | null;
  ac_venue: string | null;
  ac_branding: string | null;
};

/** Sen to ringgit, rounded to `places` so float noise never shows. */
export function senToRinggit(sen: number | string | null | undefined, places: number): number | null {
  if (sen === null || sen === undefined || sen === '') return null;
  const n = Number(sen);
  return Number.isFinite(n) ? Number((n / 100).toFixed(places)) : null;
}

/* The word the Sales Orders LIST pill shows for each stored status — the label
   half of STATUS_TONE in frontend/src/pages/scm-v2/so-list-status.ts, keyed by
   the stored value. This file's canonical test asserts the two say the same
   words. */
export const SO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Submitted',
  CANCELLED: 'Cancelled',
  CANCEL: 'Cancelled',
  INVOICED: 'Invoiced',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
  IN_PRODUCTION: 'In Production',
  READY_TO_SHIP: 'Ready to Ship',
  SHIPPED: 'Shipped',
  ON_HOLD: 'On Hold',
};

export type SoDeliveryState = 'none' | 'partial' | 'full';
export type SoLifecycleState = 'none' | 'delivered' | 'invoiced' | 'returned';

/* The statuses whose stored word stands whatever the delivery records say —
   soStatusDisplay's TERMINAL set (frontend/src/vendor/scm/lib/so-status.ts). */
const SO_TERMINAL = ['CANCELLED', 'CLOSED', 'ON_HOLD'];

/**
 * The word the Sales Orders list pill shows for one order: the stored status,
 * unless the order's own delivery records say more (Partially Delivered,
 * Delivered, Invoiced, Delivery Return) — soRowStatus over soStatusDisplay, the
 * rule the list and the detail page both render. A held order says so after
 * the word, once. The canonical test runs this against the list's own functions
 * for every combination.
 */
export function soListStatusWord(
  status: string | null | undefined,
  deliveryState: SoDeliveryState | null,
  lifecycleState: SoLifecycleState | null,
  onHold: boolean | null,
): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const stored = SO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  let word = stored;
  if (!SO_TERMINAL.includes(raw)) {
    if (lifecycleState === 'returned') word = 'Delivery Return';
    else if (lifecycleState === 'invoiced') word = 'Invoiced';
    else if (lifecycleState === 'delivered') word = deliveryState === 'partial' ? 'Partially Delivered' : 'Delivered';
    else if (deliveryState === 'partial') word = 'Partially Delivered';
    else if (deliveryState === 'full') word = 'Delivered';
  }
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}
