/* The Purchase Return and Delivery Return LINE columns — what one line of a
   return shows on the list grid and writes to the export (owner 2026-09-15:
   every transaction list exports AutoCount's listing format, one row per line,
   the grid's visible columns in on-screen order).

   WHERE THE COLUMNS COME FROM. AutoCount Accounting 2.2's own "Print Delivery
   Return Detail Listing" and "Print Purchase Return Detail Listing" grids, read
   from the program's embedded form resources on 2026-09-15
   (AutoCount.Sales.dll FormDeliveryReturnPrintDetailListing,
   AutoCount.Purchase.dll FormPurchaseReturnPrintDetailListing: each column's
   Caption and VisibleIndex). The live book (AED_HOUZS, Layout table) holds NO
   saved layout for either form, so every AutoCount user sees exactly these
   defaults. `autoCount: true` columns are those defaults, in AutoCount's order,
   under AutoCount's captions — duplicates included: AutoCount itself captions
   the document total and the line total both "Total", and the document tax and
   the line tax both "Tax". The grid shows them by default.

   `autoCount: false` columns are ERP facts AutoCount's default grid does not
   show. Each takes an AutoCount caption where the book has one for the concept
   (a hidden column of the same form: Detail Description 2, Ref, Note, Reason,
   Supplier C/N No., Our PO No., Item Group); otherwise the label the Goods
   Received / Delivery Order exports already use. They are hidden by default.

   VALUES a return in the ERP does not hold print BLANK, never an invented
   constant: Inclusive?, Proj No, Dept No, Batch No., Tax Code, Serial No. List
   (and the Purchase Return's Agent and Discount). In the live book those are
   blank on every return line too, except Inclusive? — see
   docs/line-export-columns.md §4 / §7. A return carries no tax in the ERP, so
   Tax prints 0 and Total (Ex) / Total (Inc) equal the line total.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/return-line-export-columns.ts
   (the server shapes the lines, the grid writes the sheet). Refereed by
   frontend/src/vendor/scm/lib/return-line-export-columns.canonical.test.ts and
   backend/scripts/check-shared-mirrors.mjs. No imports, so the copies stay
   identical. */

export type ReturnExportFormat = 'text' | 'number' | 'money' | 'rate' | 'date';

export type ReturnLineColumn = {
  /** The grid column key — unique within a list. */
  key: string;
  /** The header written to the file and shown on the grid. */
  label: string;
  /** One of AutoCount's default Detail Listing columns (shown by default). */
  autoCount: boolean;
  /** 'document' repeats on every line of the document; 'line' is per line. */
  level: 'document' | 'line';
  format: ReturnExportFormat;
};

export const DR_LINE_COLUMNS: readonly ReturnLineColumn[] = [
  { key: 'doc_no', label: 'Doc No', autoCount: true, level: 'document', format: 'text' },
  { key: 'doc_date', label: 'Doc Date', autoCount: true, level: 'document', format: 'date' },
  { key: 'debtor_code', label: 'Debtor Code', autoCount: true, level: 'document', format: 'text' },
  { key: 'debtor_name', label: 'Debtor Name', autoCount: true, level: 'document', format: 'text' },
  { key: 'agent', label: 'Agent', autoCount: true, level: 'document', format: 'text' },
  { key: 'currency_code', label: 'Curr. Code', autoCount: true, level: 'document', format: 'text' },
  { key: 'currency_rate', label: 'Curr. Rate', autoCount: true, level: 'document', format: 'rate' },
  { key: 'inclusive', label: 'Inclusive?', autoCount: true, level: 'document', format: 'text' },
  { key: 'subtotal_ex', label: 'SubTotal (Ex)', autoCount: true, level: 'document', format: 'money' },
  { key: 'tax', label: 'Tax', autoCount: true, level: 'document', format: 'money' },
  { key: 'total', label: 'Total', autoCount: true, level: 'document', format: 'money' },
  { key: 'local_total', label: 'Local Total', autoCount: true, level: 'document', format: 'money' },
  { key: 'cancelled', label: 'Cancelled', autoCount: true, level: 'document', format: 'text' },
  { key: 'item_code', label: 'Item Code', autoCount: true, level: 'line', format: 'text' },
  { key: 'detail_description', label: 'Detail Description', autoCount: true, level: 'line', format: 'text' },
  { key: 'uom', label: 'UOM', autoCount: true, level: 'line', format: 'text' },
  { key: 'location', label: 'Location', autoCount: true, level: 'line', format: 'text' },
  { key: 'proj_no', label: 'Proj No', autoCount: true, level: 'line', format: 'text' },
  { key: 'dept_no', label: 'Dept No', autoCount: true, level: 'line', format: 'text' },
  { key: 'batch_no', label: 'Batch No.', autoCount: true, level: 'line', format: 'text' },
  { key: 'qty', label: 'Qty', autoCount: true, level: 'line', format: 'number' },
  { key: 'unit_price', label: 'Unit Price', autoCount: true, level: 'line', format: 'rate' },
  { key: 'discount', label: 'Discount', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total', label: 'Total', autoCount: true, level: 'line', format: 'money' },
  { key: 'tax_code', label: 'Tax Code', autoCount: true, level: 'line', format: 'text' },
  { key: 'line_tax', label: 'Tax', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total_ex', label: 'Total (Ex)', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total_inc', label: 'Total (Inc)', autoCount: true, level: 'line', format: 'money' },
  { key: 'serial_no_list', label: 'Serial No. List', autoCount: true, level: 'line', format: 'text' },
  { key: 'status', label: 'Status', autoCount: false, level: 'document', format: 'text' },
  { key: 'ref', label: 'Ref', autoCount: false, level: 'document', format: 'text' },
  { key: 'reason', label: 'Reason', autoCount: false, level: 'document', format: 'text' },
  { key: 'note', label: 'Note', autoCount: false, level: 'document', format: 'text' },
  { key: 'transfer_from', label: 'DO No.', autoCount: false, level: 'document', format: 'text' },
  { key: 'so_doc_no', label: 'SO Doc No.', autoCount: false, level: 'line', format: 'text' },
  { key: 'detail_description_2', label: 'Detail Description 2', autoCount: false, level: 'line', format: 'text' },
  { key: 'remarks', label: 'Remarks', autoCount: false, level: 'line', format: 'text' },
  { key: 'item_group', label: 'Item Group', autoCount: false, level: 'line', format: 'text' },
  { key: 'condition', label: 'Condition', autoCount: false, level: 'line', format: 'text' },
  { key: 'line_id', label: 'Line ID', autoCount: false, level: 'line', format: 'text' },
];

export const PR_LINE_COLUMNS: readonly ReturnLineColumn[] = [
  { key: 'doc_no', label: 'Doc No', autoCount: true, level: 'document', format: 'text' },
  { key: 'doc_date', label: 'Doc Date', autoCount: true, level: 'document', format: 'date' },
  { key: 'creditor_code', label: 'Creditor Code', autoCount: true, level: 'document', format: 'text' },
  { key: 'creditor_name', label: 'Creditor Name', autoCount: true, level: 'document', format: 'text' },
  { key: 'agent', label: 'Agent', autoCount: true, level: 'document', format: 'text' },
  { key: 'currency_code', label: 'Curr. Code', autoCount: true, level: 'document', format: 'text' },
  { key: 'currency_rate', label: 'Curr. Rate', autoCount: true, level: 'document', format: 'rate' },
  { key: 'inclusive', label: 'Inclusive?', autoCount: true, level: 'document', format: 'text' },
  { key: 'subtotal_ex', label: 'SubTotal (Ex)', autoCount: true, level: 'document', format: 'money' },
  { key: 'tax', label: 'Tax', autoCount: true, level: 'document', format: 'money' },
  { key: 'total', label: 'Total', autoCount: true, level: 'document', format: 'money' },
  { key: 'local_total', label: 'Local Total', autoCount: true, level: 'document', format: 'money' },
  { key: 'rounding_adj', label: 'Rounding Adj.', autoCount: true, level: 'document', format: 'money' },
  { key: 'final_total', label: 'Final Total', autoCount: true, level: 'document', format: 'money' },
  { key: 'cancelled', label: 'Cancelled', autoCount: true, level: 'document', format: 'text' },
  { key: 'item_code', label: 'Item Code', autoCount: true, level: 'line', format: 'text' },
  { key: 'detail_description', label: 'Detail Description', autoCount: true, level: 'line', format: 'text' },
  { key: 'uom', label: 'UOM', autoCount: true, level: 'line', format: 'text' },
  { key: 'location', label: 'Location', autoCount: true, level: 'line', format: 'text' },
  { key: 'proj_no', label: 'Proj No', autoCount: true, level: 'line', format: 'text' },
  { key: 'dept_no', label: 'Dept No', autoCount: true, level: 'line', format: 'text' },
  { key: 'batch_no', label: 'Batch No.', autoCount: true, level: 'line', format: 'text' },
  { key: 'qty', label: 'Qty', autoCount: true, level: 'line', format: 'number' },
  { key: 'unit_price', label: 'Unit Price', autoCount: true, level: 'line', format: 'rate' },
  { key: 'discount', label: 'Discount', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total', label: 'Total', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_local_total', label: 'Local Total', autoCount: true, level: 'line', format: 'money' },
  { key: 'tax_code', label: 'Tax Code', autoCount: true, level: 'line', format: 'text' },
  { key: 'line_tax', label: 'Tax', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total_ex', label: 'Total (Ex)', autoCount: true, level: 'line', format: 'money' },
  { key: 'line_total_inc', label: 'Total (Inc)', autoCount: true, level: 'line', format: 'money' },
  { key: 'serial_no_list', label: 'Serial No. List', autoCount: true, level: 'line', format: 'text' },
  { key: 'is_rounding_adj', label: 'Is Rounding Adj.', autoCount: true, level: 'document', format: 'text' },
  { key: 'status', label: 'Status', autoCount: false, level: 'document', format: 'text' },
  { key: 'supplier_cn_no', label: 'Supplier C/N No.', autoCount: false, level: 'document', format: 'text' },
  { key: 'reason', label: 'Reason', autoCount: false, level: 'line', format: 'text' },
  { key: 'transfer_from', label: 'GRN No.', autoCount: false, level: 'line', format: 'text' },
  { key: 'our_po_no', label: 'Our PO No.', autoCount: false, level: 'line', format: 'text' },
  { key: 'detail_description_2', label: 'Detail Description 2', autoCount: false, level: 'line', format: 'text' },
  { key: 'remarks', label: 'Remarks', autoCount: false, level: 'line', format: 'text' },
  { key: 'item_group', label: 'Item Group', autoCount: false, level: 'line', format: 'text' },
  { key: 'line_id', label: 'Line ID', autoCount: false, level: 'line', format: 'text' },
];

/** One Delivery Return line as the list endpoint and the export send it. Money
 *  stays in SEN on the wire; the grid converts at the cell (`senToRinggit`). */
export type DrListLine = {
  id: string;
  /** Item Code, Description, Item Group and UOM are the account book's for a
   *  HOUZS line (bookLineItem), the ERP's own where the book has no such item. */
  item_code: string | null;
  description: string | null;
  /** Composed from the variants, else the stored text. */
  description2: string | null;
  notes: string | null;
  item_group: string | null;
  condition: string | null;
  uom: string | null;
  qty_returned: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  /** AutoCount's short location code (`KL`) of the warehouse the line went back
   *  into: its SO line's warehouse, else the delivery order's, else the return's. */
  location: string | null;
  /** The Sales Order the delivered line was sold on (DO line -> SO line). */
  so_doc_no: string | null;
};

/** One Purchase Return line as the list endpoint and the export send it. */
export type PrListLine = {
  id: string;
  /** As on DrListLine: the book's item facts for a HOUZS line. `description` is
   *  the book's, else material_name, else description; `material_name` is raw. */
  item_code: string | null;
  material_name: string | null;
  description: string | null;
  /** Composed from the variants, else the stored text. */
  description2: string | null;
  notes: string | null;
  reason: string | null;
  item_group: string | null;
  uom: string | null;
  qty_returned: number;
  unit_price_sen: number | null;
  line_refund_sen: number | null;
  /** AutoCount's short location code of the receipt the goods came in on. */
  location: string | null;
  /** The Goods Received Note the line returns from (grn_item_id), else the return's. */
  grn_no: string | null;
  /** The Purchase Order behind that receipt line, else the return's. */
  po_no: string | null;
};

export type DrLineSource = {
  id: string;
  item_code?: string | null;
  description?: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  condition?: string | null;
  uom?: string | null;
  qty_returned?: number | string | null;
  unit_price_sen?: number | string | null;
  discount_sen?: number | string | null;
  line_total_sen?: number | string | null;
};

export type PrLineSource = {
  id: string;
  item_code?: string | null;
  material_name?: string | null;
  description?: string | null;
  description2?: string | null;
  notes?: string | null;
  reason?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty_returned?: number | string | null;
  unit_price_sen?: number | string | null;
  line_refund_sen?: number | string | null;
};

/** What the server works out for a line before shaping it: the item as the
 *  account book lists it (Item Code, Description, Item Group, UOM — the shared
 *  bookLineItem) and Item Description 2 composed from the line's variants
 *  (owner 2026-09-15). */
export type ReturnLineBookFacts = {
  itemCode: string | null;
  description: string | null;
  itemGroup: string | null;
  uom: string | null;
  description2: string | null;
};

export function toDrListLine(
  line: DrLineSource,
  ctx: ReturnLineBookFacts & { location: string | null; soDocNo: string | null },
): DrListLine {
  return {
    id: line.id,
    item_code: text(ctx.itemCode),
    description: text(ctx.description),
    description2: text(ctx.description2),
    notes: text(line.notes),
    item_group: text(ctx.itemGroup),
    condition: text(line.condition),
    uom: text(ctx.uom),
    qty_returned: num(line.qty_returned) ?? 0,
    unit_price_sen: num(line.unit_price_sen),
    discount_sen: num(line.discount_sen),
    line_total_sen: num(line.line_total_sen),
    location: text(ctx.location),
    so_doc_no: text(ctx.soDocNo),
  };
}

export function toPrListLine(
  line: PrLineSource,
  ctx: ReturnLineBookFacts & { location: string | null; grnNo: string | null; poNo: string | null },
): PrListLine {
  return {
    id: line.id,
    item_code: text(ctx.itemCode),
    material_name: text(line.material_name),
    description: text(ctx.description),
    description2: text(ctx.description2),
    notes: text(line.notes),
    reason: text(line.reason),
    item_group: text(ctx.itemGroup),
    uom: text(ctx.uom),
    qty_returned: num(line.qty_returned) ?? 0,
    unit_price_sen: num(line.unit_price_sen),
    line_refund_sen: num(line.line_refund_sen),
    location: text(ctx.location),
    grn_no: text(ctx.grnNo),
    po_no: text(ctx.poNo),
  };
}

/** Stored sen -> ringgit, as a NUMBER a spreadsheet can add up. `places` only
 *  trims float noise: a unit price is a rate and keeps 4, an amount keeps 2. */
export function senToRinggit(sen: number | string | null | undefined, places: 2 | 4): number | null {
  const n = num(sen);
  if (n === null) return null;
  return Number((n / 100).toFixed(places));
}

/** AutoCount's Curr. Rate: 1 for the local currency (MYR), where the rate is 1
 *  by definition; blank for any other, because a return stores no rate. */
export function returnCurrencyRate(currency: string | null | undefined): number | null {
  return (currency ?? '').trim().toUpperCase() === 'MYR' ? 1 : null;
}

/** AutoCount's Cancelled column, in words. */
export function returnCancelledWord(status: string | null | undefined): string {
  return (status ?? '').trim().toUpperCase() === 'CANCELLED' ? 'Yes' : 'No';
}

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
