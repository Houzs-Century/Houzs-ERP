/* The Goods Received grid's LINE columns (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I choose").
 *
 * On screen each is compact per receipt (components/dataTableLineCells.tsx, the
 * one renderer every line-exporting list shares); in the export each line gets
 * its own row and cell. Labels are AutoCount's Goods Received Detail Listing
 * captions (GRN_LABELS). Values arrive spelled the AutoCount way from the server
 * (lib/grn-export-rows.ts). Money is sen on screen, ringgit in the file. */

import { fmtDate, fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { GRN_LABELS as L, senToRinggit, type GrnListLine } from "../../vendor/scm/lib/grn-list-export";

export type GrnGridRow = { id: string; lines?: GrnListLine[] };
export type GrnColumn<T extends GrnGridRow> = Column<T, GrnListLine>;

export function grnLineColumns<T extends GrnGridRow>(): Record<string, GrnColumn<T>> {
  const linesOf = (r: T): readonly GrnListLine[] => r.lines ?? [];
  const text = (key: string, label: string, pick: (l: GrnListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
    lineTextColumn<T, GrnListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden });
  const qty = (key: string, label: string, pick: (l: GrnListLine) => number | null, hidden = false) =>
    lineSumColumn<T, GrnListLine>({ key, label, linesOf, pick, exportFormat: "number", defaultHidden: hidden });
  const money = (key: string, label: string, pick: (l: GrnListLine) => number | null, hidden = false) =>
    lineSumColumn<T, GrnListLine>({
      key, label, linesOf, pick, exportFormat: "money", toExport: (sen) => senToRinggit(sen, 2), format: (sum) => fmtSen(sum), defaultHidden: hidden,
    });
  /* AutoCount's line columns that hold no value in this ERP (Proj No, Tax Code,
     line Tax, the Desc2 UDF): the column exists so the file has AutoCount's
     shape, and every cell is blank. */
  const blank = (key: string, label: string) => text(key, label, () => null, { width: "90px" });

  return {
    item_code: text("item_code", L.itemCode, (l) => l.ac_item_code, { width: "200px", mono: true }),
    detail_description: text("detail_description", L.detailDescription, (l) => l.book_description, { width: "240px" }),
    detail_description_2: text("detail_description_2", L.detailDescription2, (l) => l.description2, { width: "240px" }),
    uom: text("uom", L.uom, (l) => l.book_uom, { width: "80px" }),
    location: text("location", L.location, (l) => l.location, { width: "90px" }),
    proj_no: blank("proj_no", L.projNo),
    qty: qty("qty", L.qty, (l) => l.qty),
    /* A unit price is a rate: RM on screen, up to four decimals in the file. */
    unit_price: {
      ...lineTextColumn<T, GrnListLine>({
        key: "unit_price", label: L.unitPrice, linesOf, width: "120px",
        pick: (l) => (l.unit_price_sen === null ? null : String(l.unit_price_sen)),
        format: (v) => fmtSen(Number(v)),
      }),
      lineValue: (_r, l) => senToRinggit(l.unit_price_sen, 4),
      exportFormat: "rate",
    },
    discount: money("discount", L.discount, (l) => l.discount_sen),
    line_total: money("line_total", L.lineTotal, (l) => l.line_total_sen),
    tax_code: blank("tax_code", L.taxCode),
    line_tax: blank("line_tax", L.lineTax),
    /* No tax on a receipt line in this ERP: Total (Ex) and Total (Inc) are the
       line total. */
    total_ex: money("total_ex", L.totalEx, (l) => l.line_total_sen),
    total_inc: money("total_inc", L.totalInc, (l) => l.line_total_sen),
    desc2: blank("desc2", L.desc2),
    our_po_no: text("our_po_no", L.ourPoNo, (l) => l.our_po_no, { width: "130px", mono: true }),

    item_group: text("item_group", L.itemGroup, (l) => l.book_item_group, { width: "110px", hidden: true }),
    delivery_date: {
      ...lineTextColumn<T, GrnListLine>({
        key: "delivery_date", label: L.deliveryDate, linesOf, width: "120px", defaultHidden: true,
        pick: (l) => l.delivery_date, exportFormat: "date", format: (v) => fmtDate(v),
      }),
    },
    erp_item_code: text("erp_item_code", L.erpItemCode, (l) => l.item_code, { width: "180px", mono: true, hidden: true }),
    remarks: text("remarks", L.remarks, (l) => l.remarks, { width: "200px", hidden: true }),
    invoiced_qty: qty("invoiced_qty", L.invoicedQty, (l) => l.invoiced_qty, true),
    returned_qty: qty("returned_qty", L.returnedQty, (l) => l.returned_qty, true),
    uninvoiced_qty: qty("uninvoiced_qty", L.uninvoicedQty, (l) => l.uninvoiced_qty, true),
    invoice_no: text("invoice_no", L.invoiceNo, (l) => l.invoice_nos, { width: "150px", mono: true, hidden: true }),
    so_doc_no: text("so_doc_no", L.soDocNo, (l) => l.so_doc_no, { width: "150px", mono: true, hidden: true }),
    line_id: text("line_id", L.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}
