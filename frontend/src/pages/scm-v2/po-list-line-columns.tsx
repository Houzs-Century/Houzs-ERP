/* The Purchase Orders grid's LINE columns (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I choose").
 *
 * On screen each is compact per purchase order (components/dataTableLineCells.tsx,
 * shared by every list that exports by line); in the export each line gets its
 * own row and cell. Labels come from PO_LINE_LABELS — AutoCount's PO listing
 * captions — because the PO line import reads an exported file back by exactly
 * these names. */

import { fmtDate, fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import type { PoHeaderRow } from "../../vendor/scm/lib/suppliers-queries";
import {
  PO_LINE_LABELS,
  senToRinggit,
  type PoListLine,
} from "../../vendor/scm/lib/po-line-export-columns";

export type PoGridRow = PoHeaderRow;
export type PoColumn = Column<PoGridRow, PoListLine>;

const linesOf = (r: PoGridRow): readonly PoListLine[] => r.lines ?? [];
const text = (key: string, label: string, pick: (l: PoListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
  lineTextColumn<PoGridRow, PoListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden });
const date = (key: string, label: string, pick: (l: PoListLine) => string | null) =>
  lineTextColumn<PoGridRow, PoListLine>({ key, label, linesOf, pick, width: "150px", exportFormat: "date", format: (v) => fmtDate(v) });

/** The line columns, keyed for the grid. The page decides the order. */
export function poLineColumns(): Record<string, PoColumn> {
  return {
    so_doc_no: text("so_doc_no", PO_LINE_LABELS.soDocNo, (l) => l.so_doc_no, { mono: true }),
    item_code: text("item_code", PO_LINE_LABELS.itemCode, (l) => l.supplier_sku, { width: "200px", mono: true }),
    item_description: text("item_description", PO_LINE_LABELS.itemDescription, (l) => l.item_description, { width: "240px" }),
    item_description_2: text("item_description_2", PO_LINE_LABELS.itemDescription2, (l) => l.description2, { width: "240px" }),
    location: text("location", PO_LINE_LABELS.location, (l) => l.location, { width: "100px" }),
    item_group: text("item_group", PO_LINE_LABELS.itemGroup, (l) => l.ac_item_group, { width: "120px" }),
    remaining_qty: lineSumColumn<PoGridRow, PoListLine>({
      key: "remaining_qty", label: PO_LINE_LABELS.remainingQty, linesOf, pick: (l) => l.remaining_qty, exportFormat: "number",
    }),
    delivery_date: date("delivery_date", PO_LINE_LABELS.deliveryDate, (l) => l.delivery_date),
    estimate_delivery_date_1: date("estimate_delivery_date_1", PO_LINE_LABELS.estimate1, (l) => l.estimate_delivery_date_1),
    estimate_delivery_date_2: date("estimate_delivery_date_2", PO_LINE_LABELS.estimate2, (l) => l.estimate_delivery_date_2),
    estimate_delivery_date_3: date("estimate_delivery_date_3", PO_LINE_LABELS.estimate3, (l) => l.estimate_delivery_date_3),
    erp_item_code: text("erp_item_code", PO_LINE_LABELS.erpItemCode, (l) => l.item_code, { width: "180px", mono: true, hidden: true }),
    remarks: text("remarks", PO_LINE_LABELS.remarks, (l) => l.notes, { width: "200px", hidden: true }),
    qty: lineSumColumn<PoGridRow, PoListLine>({
      key: "qty", label: PO_LINE_LABELS.qty, linesOf, pick: (l) => l.qty, exportFormat: "number", defaultHidden: true,
    }),
    received_qty: lineSumColumn<PoGridRow, PoListLine>({
      key: "received_qty", label: PO_LINE_LABELS.receivedQty, linesOf, pick: (l) => l.received_qty, exportFormat: "number", defaultHidden: true,
    }),
    /* Stored in sen. On screen RM; in the file ringgit numbers — a unit price is
       a rate and keeps up to 4 decimals, a total keeps 2. */
    unit_price: {
      ...lineTextColumn<PoGridRow, PoListLine>({
        key: "unit_price", label: PO_LINE_LABELS.unitPrice, linesOf, width: "130px", defaultHidden: true,
        pick: (l) => (l.unit_price_sen === null ? null : String(l.unit_price_sen)),
        format: (v) => fmtSen(Number(v)),
      }),
      lineValue: (_r, l) => senToRinggit(l.unit_price_sen, 4),
      exportFormat: "rate",
    },
    line_total: lineSumColumn<PoGridRow, PoListLine>({
      key: "line_total", label: PO_LINE_LABELS.lineTotal, linesOf, pick: (l) => l.line_total_sen, exportFormat: "money",
      toExport: (sen) => senToRinggit(sen, 2), format: (sum) => fmtSen(sum), defaultHidden: true,
    }),
    line_id: text("line_id", PO_LINE_LABELS.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}
