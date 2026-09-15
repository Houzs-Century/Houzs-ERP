/* The Delivery Order LINE values — what one line of a delivery order shows and
   exports, owner 2026-09-15.

   The DO list's ONE Export follows the grid: one row per DO line, the columns
   the operator has visible, in their order, under their labels (DataTable
   `exportLines`). The labels are AutoCount's own captions, read out of the saved
   grid layouts of the live book (table Layout, form
   FormDeliveryOrderPrintDetailListing).

   NO PRICES (owner 2026-09-15): this file goes to drivers, 3PLs and customers.
   The line shape carries no price or amount and the server does not even read
   them; the default column set holds none. Driver and Vehicle stay although every
   delivery order has them empty today.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/do-line-export-columns.ts.
   Refereed by frontend/src/vendor/scm/lib/do-line-export-columns.canonical.test.ts
   and backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

export const DO_LABELS = {
  /* Header — AutoCount captions. */
  docNo: 'Doc No',
  docDate: 'Doc Date',
  ref: 'Ref',
  debtorCode: 'Debtor Code',
  debtorName: 'Debtor Name',
  agent: 'Agent',
  currency: 'Curr. Code',
  /* Line — AutoCount captions. */
  itemCode: 'Item Code',
  detailDescription: 'Detail Description',
  detailDescription2: 'Detail Description 2',
  uom: 'UOM',
  location: 'Location',
  qty: 'Qty',
  poDocNo: 'PO Doc No.',
  itemGroup: 'Item Group',
  /* The ERP's own, no AutoCount caption. */
  invoicedQty: 'Invoiced Qty',
  returnedQty: 'Returned Qty',
  uninvoicedQty: 'Uninvoiced Qty',
  m3: 'm³',
  deliveryDate: 'Delivery Date',
  soDocNo: 'SO Doc No.',
  invoiceNo: 'Invoice No.',
  remarks: 'Remarks',
  driver: 'Driver',
  vehicle: 'Vehicle',
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  lineId: 'Line ID',
} as const;

/** AutoCount layout "LISTING ITEM DETAIL" (the book's default Delivery Order
 *  Detail Listing), in AutoCount's order, WITHOUT its Total and Unit Price
 *  (no prices on a delivery order file) and without PO DocKey (an AutoCount
 *  internal key). Provisional default, 2026-09-15. */
export const DO_DEFAULT_COLUMNS = [
  DO_LABELS.docNo, DO_LABELS.docDate, DO_LABELS.debtorCode, DO_LABELS.debtorName, DO_LABELS.agent,
  DO_LABELS.currency, DO_LABELS.itemCode, DO_LABELS.detailDescription, DO_LABELS.detailDescription2,
  DO_LABELS.uom, DO_LABELS.location, DO_LABELS.qty, DO_LABELS.poDocNo, DO_LABELS.itemGroup,
] as const;

/** One DO line as the list endpoint and the export send it. No money. */
export type DoListLine = {
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
  m3: number | null;
  delivery_date: string | null;
  remark: string | null;
  invoiced_qty: number | null;
  returned_qty: number | null;
  uninvoiced_qty: number | null;
  so_doc_no: string | null;
  invoice_nos: string[];
  po_nos: string[];
};

/** The delivery order's header values as AutoCount holds them. For a delivery
 *  order that is not in AutoCount (2990) these are the ERP's own values. */
export type DoBookHeader = {
  ac_doc_no: string | null;
  ac_debtor_code: string | null;
  ac_agent: string | null;
};

/* The word the Delivery Orders LIST pill shows for each stored status — the
   label half of STATUS_TONE in frontend/src/pages/scm-v2/do-list-status.ts,
   keyed by the stored value. This file's canonical test asserts the two say the
   same words. LOADED reads "Confirmed" and DISPATCHED "Loaded" on screen. */
export const DO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  LOADED: 'Confirmed',
  DISPATCHED: 'Loaded',
  IN_TRANSIT: 'In transit',
  SIGNED: 'Delivered',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  CANCEL: 'Cancelled',
};

export function doStatusWord(status: string | null | undefined, onHold: boolean | null): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = DO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true ? `${word} (On Hold)` : word;
}
