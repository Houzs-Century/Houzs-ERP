/* The Purchase Order LINE values — what one line of a purchase order shows and
   exports, owner 2026-09-15.

   The PO list's ONE Export follows the grid: one row per PO line, the columns
   the operator has visible, in their order, under their labels (DataTable
   `exportLines`). The line columns the grid offers are named here, and so is
   the server's line shape they read, so the list endpoint, the export and the
   import agree on every name.

   THE LABELS ARE AN IMPORT CONTRACT. The PO line import reads a file back by
   header name — Line ID plus the editable columns — and a grid export writes the
   column LABEL as the header. Rename a label here and every file already
   exported stops importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/po-line-export-columns.ts.
   Refereed by frontend/src/vendor/scm/lib/po-line-export-columns.canonical.test.ts
   and backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

/* WHICH STORED DATE IS "Estimate Delivery Date 1 / 2 / 3". The ONE place that
   decides it — correct it here and every screen and export reading the
   estimates follows (the PO line export and the Outstanding "PO Chasing" tab).

   Checked against live AutoCount 2026-09-15: the book keeps these three on the
   PO HEADER as UDF_EDate / UDF_EDate2 / UDF_EDate3 (captioned "Supplier
   Delivery Date"). The ERP keeps the same three dates as
   supplier_delivery_date_2/3/4 — on the purchase_orders header, cascaded onto
   every line (POST /bulk-supplier-date), and editable per line on PoLineCard
   ("Supplier Date 2/3/4"). delivery_date stays the line's own Delivery Date.

   A LINE value wins over the header's: the line is where a date that differs
   per item lives, and the cascade writes both halves the same. The header value
   is used only where the line is blank. */
export const PO_ESTIMATE_DELIVERY_DATE_FIELDS = [
  'supplier_delivery_date_2',
  'supplier_delivery_date_3',
  'supplier_delivery_date_4',
] as const;

/** What the three are called, on every screen and in every export — AutoCount's
 *  own PO listing captions, exactly (owner 2026-09-15: "100% like AutoCount"). */
export const PO_ESTIMATE_DELIVERY_DATE_LABELS = [
  'Estimate Delivery Date',
  'Supplier Delivery Date 2',
  'Supplier Delivery Date 3',
] as const;

export type PoEstimateDates = {
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
};

/** Estimate Delivery Date 1, 2, 3 for one line: the line's own date, else the
 *  PO header's, as YYYY-MM-DD or null. */
export function poEstimateDeliveryDates(
  line: PoEstimateDates,
  header: PoEstimateDates | null | undefined,
): [string | null, string | null, string | null] {
  const pick = (i: 0 | 1 | 2): string | null => {
    const field = PO_ESTIMATE_DELIVERY_DATE_FIELDS[i];
    return isoDate(line[field]) ?? isoDate(header?.[field]);
  };
  return [pick(0), pick(1), pick(2)];
}

/* The word the Purchase Orders LIST shows for each stored status — the export
   prints the same word (owner 2026-09-15). The list keeps its own map (watched
   by localStatusMapsAgree.test.ts); this file's canonical test asserts the two
   say the same words. A held order keeps its real status and carries
   the hold MARKER beside it (mig 0324), which the list draws as a chip; the
   export writes it after the word. */
export const PO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On Hold',
};

export function poStatusWord(status: string | null | undefined, onHold: boolean | null | undefined): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = PO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}

/** The grid's column labels. The first fifteen are AutoCount's PO listing
 *  columns, in AutoCount's order (the grid's default view); the rest are extra
 *  columns the chooser offers. A grid export writes these labels as headers, and
 *  the PO line import reads a file back by them. */
export const PO_LINE_LABELS = {
  docNo: 'Doc No',
  soDocNo: 'SO Doc No.',
  creditorCode: 'Creditor Code',
  creditorName: 'Creditor Name',
  itemCode: 'Item Code',
  itemDescription: 'Item Description',
  itemDescription2: 'Item Description 2',
  location: 'Location',
  itemGroup: 'Item Group',
  docDate: 'Doc Date',
  remainingQty: 'Remaining Qty',
  deliveryDate: 'Delivery Date',
  estimate1: PO_ESTIMATE_DELIVERY_DATE_LABELS[0],
  estimate2: PO_ESTIMATE_DELIVERY_DATE_LABELS[1],
  estimate3: PO_ESTIMATE_DELIVERY_DATE_LABELS[2],
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  remarks: 'Remarks',
  qty: 'Qty',
  receivedQty: 'Received Qty',
  unitPrice: 'Unit Price',
  lineTotal: 'Line Total',
  lineId: 'Line ID',
} as const;

export type PoLineLabel = (typeof PO_LINE_LABELS)[keyof typeof PO_LINE_LABELS];

/* AutoCount's Item Group for an ERP item_group. Measured 2026-09-15 on the 240
   lines of the owner's AutoCount "PO chasing list" (20260904) that match an ERP
   line by AutoCount doc no + supplier item code: sofa -> SOFA (13),
   fabric_accessory -> SOFA (35; the book files a sofa's pillows under the sofa),
   accessory -> ACC (11), mattress -> MATTRESS (90), bedframe -> BEDFRAME (91).
   A group the book was not seen using prints upper-cased. */
const AC_ITEM_GROUP: Readonly<Record<string, string>> = {
  accessory: 'ACC',
  fabric_accessory: 'SOFA',
};

export function acItemGroup(itemGroup: string | null | undefined): string | null {
  const g = (itemGroup ?? '').trim();
  if (!g) return null;
  return AC_ITEM_GROUP[g.toLowerCase()] ?? g.toUpperCase();
}

/** One PO line as the list endpoint and the export send it. Money stays in sen
 *  on the wire; the grid converts at the cell (`senToRinggit`). */
export type PoListLine = {
  id: string;
  line_no: number | null;
  item_code: string | null;
  material_name: string | null;
  /** AutoCount's Item Description: the book's item master for the supplier item
   *  code, else the ERP's material_name. */
  item_description: string | null;
  description2: string | null;
  notes: string | null;
  item_group: string | null;
  /** AutoCount's Item Group: the book's item master, else acItemGroup(item_group). */
  ac_item_group: string | null;
  supplier_sku: string | null;
  qty: number;
  received_qty: number;
  remaining_qty: number;
  unit_price_sen: number | null;
  line_total_sen: number | null;
  delivery_date: string | null;
  estimate_delivery_date_1: string | null;
  estimate_delivery_date_2: string | null;
  estimate_delivery_date_3: string | null;
  /** AutoCount's short location code (`KL`), line warehouse else PO ship-to. */
  location: string | null;
  /** The Sales Order the line was raised for (via so_item_id), company-scoped. */
  so_doc_no: string | null;
};

export type PoLineSource = PoEstimateDates & {
  id: string;
  line_no?: number | null;
  item_code?: string | null;
  material_name?: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  supplier_sku?: string | null;
  qty?: number | string | null;
  received_qty?: number | string | null;
  unit_price_sen?: number | string | null;
  line_total_sen?: number | string | null;
  delivery_date?: string | null;
};

export function toPoListLine(
  header: PoEstimateDates | null | undefined,
  line: PoLineSource,
  ctx: {
    location: string | null;
    soDocNo: string | null;
    /** The AutoCount item master row for the line's supplier item code, or null. */
    book: { description: string | null; itemGroup: string | null } | null;
  },
): PoListLine {
  const qty = num(line.qty) ?? 0;
  const received = num(line.received_qty) ?? 0;
  const [e1, e2, e3] = poEstimateDeliveryDates(line, header);
  return {
    id: line.id,
    line_no: num(line.line_no),
    item_code: text(line.item_code),
    material_name: text(line.material_name),
    item_description: text(ctx.book?.description) ?? text(line.material_name),
    description2: text(line.description2),
    notes: text(line.notes),
    item_group: text(line.item_group),
    ac_item_group: text(ctx.book?.itemGroup) ?? acItemGroup(line.item_group),
    supplier_sku: text(line.supplier_sku),
    qty,
    received_qty: received,
    remaining_qty: Number((qty - received).toFixed(4)),
    unit_price_sen: num(line.unit_price_sen),
    line_total_sen: num(line.line_total_sen),
    delivery_date: isoDate(line.delivery_date),
    estimate_delivery_date_1: e1,
    estimate_delivery_date_2: e2,
    estimate_delivery_date_3: e3,
    location: text(ctx.location),
    so_doc_no: text(ctx.soDocNo),
  };
}

/** Stored sen -> ringgit, as a NUMBER a spreadsheet can add up. `places` only
 *  trims float noise: a unit price is a rate and keeps 4, an amount keeps 2. */
export function senToRinggit(sen: number | string | null | undefined, places: 2 | 4): number | null {
  const n = num(sen);
  if (n === null) return null;
  return Number((n / 100).toFixed(places));
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

/* The storage shape (YYYY-MM-DD) — a spreadsheet sorts it, and it imports back
   without a day/month guess. A timestamp keeps only its date. */
const isoDate = (v: string | null | undefined): string | null => {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : s;
};
