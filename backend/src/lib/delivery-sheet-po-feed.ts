/**
 * The HC Delivery sheet's Outstanding PO feed — phase 3 of the ERP cutover
 * (owner 2026-09-16: 「第三期换 Outstanding PO」).
 *
 * `reference/PO_Outstanding.gs` used to pull AutoCount's
 * `GET /PurchaseOrder/getOutstanding` into the "Outstanding PO" tab (header at
 * row 11, rows 1–10 kept for the team) and push the three "Supplier Delivery
 * Date" columns back with `PUT /PurchaseOrder/update-udf-dates` — the book's
 * header UDFs `EDate / EDate2 / EDate3`, which the ERP already maps to
 * `supplier_delivery_date_2 / 3 / 4` (services/autocount-po-supplier-dates.ts).
 * This module emits the AutoCount field NAMES the script keys on, so the sheet
 * side only changes its URL.
 *
 * Kept free of Hono so the SQL runs in tests-pg against real Postgres.
 */
import { PO_STATUS_BUCKETS } from "../scm/lib/po-status-buckets";

/** Raised but not received in full — the PO list's own `outstanding` roll-up,
 *  the single home of that decision (audit:duplicated-decisions). A held PO
 *  is still outstanding; RECEIVED, CANCELLED and DRAFT are not. */
export const PO_OUTSTANDING_STATUSES: readonly string[] = PO_STATUS_BUCKETS.outstanding!;

const inList = (xs: Iterable<string>) => [...xs].sort().map((s) => `'${s}'`).join(", ");

/** One outstanding PO LINE, as the feed SQL returns it (dates as `::text`). */
export type PoFeedRow = {
  po_id: string;
  po_number: string;
  linked_ac_docno: string | null;
  status: string;
  on_hold: boolean | null;
  so_doc_no: string | null;
  so_ac_docno: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  item_code: string | null;
  item_description: string | null;
  description2: string | null;
  location: string | null;
  item_group: string | null;
  doc_date: string | null;
  remaining_qty: number;
  delivery_date: string | null;
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
};

/** The record the sheet's writer reads — AutoCount's field names, on purpose. */
export type OutstandingPoRecord = {
  DocNo: string;
  ErpDocNo: string;
  SODocNo: string | null;
  CreditorCode: string | null;
  CreditorName: string | null;
  ItemCode: string | null;
  ItemDescription: string | null;
  ItemDescription2: string | null;
  Location: string | null;
  ItemGroup: string | null;
  DocDate: string | null;
  RemainingQty: number;
  DeliveryDate: string | null;
  SupplierDeliveryDate1: string | null;
  SupplierDeliveryDate2: string | null;
  SupplierDeliveryDate3: string | null;
  Status: string;
  OnHold: boolean;
};

/**
 * Binds: ?1 company_id. Every line with quantity still to receive on a PO the
 * list calls outstanding, this company only, oldest PO first and lines in
 * their stored order. Location is the line's warehouse, else the header's
 * (the same effective-warehouse rule as the GRN picker); Delivery Date is the
 * line's own, else the header's expected date; the three supplier dates are
 * HEADER slots 2/3/4, which is what the book's UDFs hold. SO Doc No. is the
 * book's number for the line's source order, when the line has one.
 */
export const FEED_OUTSTANDING_PO_SQL = `
SELECT po.id::text AS po_id,
       po.po_number,
       po.linked_ac_docno,
       po.status::text AS status,
       po.on_hold,
       so.doc_no AS so_doc_no,
       so.linked_ac_docno AS so_ac_docno,
       sup.code AS creditor_code,
       sup.name AS creditor_name,
       i.item_code,
       COALESCE(NULLIF(i.description, ''), i.material_name) AS item_description,
       i.description2,
       wh.code AS location,
       i.item_group,
       po.po_date::text AS doc_date,
       (i.qty - COALESCE(i.received_qty, 0))::int AS remaining_qty,
       COALESCE(i.delivery_date, po.expected_at)::text AS delivery_date,
       po.supplier_delivery_date_2::text AS supplier_delivery_date_2,
       po.supplier_delivery_date_3::text AS supplier_delivery_date_3,
       po.supplier_delivery_date_4::text AS supplier_delivery_date_4
  FROM scm.purchase_order_items i
  JOIN scm.purchase_orders po ON po.id = i.purchase_order_id
  LEFT JOIN scm.suppliers sup ON sup.id = po.supplier_id
  LEFT JOIN scm.warehouses wh ON wh.id = COALESCE(i.warehouse_id, po.purchase_location_id)
  LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
  LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
 WHERE po.company_id = ?1
   AND po.status::text IN (${inList(PO_OUTSTANDING_STATUSES)})
   AND i.qty - COALESCE(i.received_qty, 0) > 0
 ORDER BY po.po_date, po.po_number, i.line_no NULLS FIRST, i.created_at, i.id`;

const blankToNull = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

export function toOutstandingPoRecord(r: PoFeedRow): OutstandingPoRecord {
  return {
    // The book's number when the PO has one, so the sheet's key does not change.
    DocNo: r.linked_ac_docno ?? r.po_number,
    ErpDocNo: r.po_number,
    SODocNo: r.so_ac_docno ?? r.so_doc_no ?? null,
    CreditorCode: blankToNull(r.creditor_code),
    CreditorName: blankToNull(r.creditor_name),
    ItemCode: blankToNull(r.item_code),
    ItemDescription: blankToNull(r.item_description),
    ItemDescription2: blankToNull(r.description2),
    Location: blankToNull(r.location),
    ItemGroup: blankToNull(r.item_group),
    DocDate: r.doc_date,
    RemainingQty: Number(r.remaining_qty ?? 0),
    DeliveryDate: r.delivery_date,
    SupplierDeliveryDate1: r.supplier_delivery_date_2,
    SupplierDeliveryDate2: r.supplier_delivery_date_3,
    SupplierDeliveryDate3: r.supplier_delivery_date_4,
    Status: r.status,
    OnHold: r.on_hold === true,
  };
}

/** The sheet's three date columns → the ERP's header slots. Slot 1 of the ERP
 *  is the base date (`expected_at`), so the sheet's 1/2/3 are slots 2/3/4. */
export const SHEET_PO_DATE_SLOTS = [
  ["SupplierDeliveryDate1", 2],
  ["SupplierDeliveryDate2", 3],
  ["SupplierDeliveryDate3", 4],
] as const;

/** One PO header as the write leg reads it before deciding what moved. */
export type PoHeadForSheet = {
  id: string;
  po_number: string;
  linked_ac_docno: string | null;
  status: string;
  company_id: number;
  supplier_delivery_date_2: string | null;
  supplier_delivery_date_3: string | null;
  supplier_delivery_date_4: string | null;
  sheet_doc_no: string;
};

/**
 * Binds, in order: one `?` per sheet Doc. No., then the company id. Finds each
 * PO by the sheet's AutoCount number OR the ERP number, within the secret's
 * company; unknown numbers simply return no row.
 */
export function poHeadsForSheetSql(docCount: number): string {
  const values = Array.from({ length: docCount }, () => "(?::text)").join(", ");
  return `
SELECT po.id::text AS id,
       po.po_number,
       po.linked_ac_docno,
       po.status::text AS status,
       po.company_id,
       po.supplier_delivery_date_2::text AS supplier_delivery_date_2,
       po.supplier_delivery_date_3::text AS supplier_delivery_date_3,
       po.supplier_delivery_date_4::text AS supplier_delivery_date_4,
       v.sheet_doc_no
  FROM (VALUES ${values}) AS v(sheet_doc_no)
  JOIN scm.purchase_orders po
    ON (po.linked_ac_docno = v.sheet_doc_no OR po.po_number = v.sheet_doc_no)
 WHERE po.company_id = ?`;
}
