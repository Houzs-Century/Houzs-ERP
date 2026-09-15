/* The Purchase Invoices grid's LINE columns (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I choose").
 *
 * On screen each is compact per invoice (components/dataTableLineCells.tsx, the
 * one renderer every line-exporting list shares); in the export each line gets
 * its own row and cell. Labels are AutoCount's Purchase Invoice Detail Listing
 * captions (PI_LABELS). Values arrive spelled the AutoCount way from the server
 * (lib/pi-export-rows.ts). Money is sen on screen, ringgit in the file. */

import { fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { PI_LABELS as L, senToRinggit, type PiListLine } from "../../vendor/scm/lib/pi-list-export";

export type PiGridRow = { id: string; lines?: PiListLine[] };

export function piLineColumns<T extends PiGridRow>(): Record<string, Column<T, PiListLine>> {
  const linesOf = (r: T): readonly PiListLine[] => r.lines ?? [];
  const text = (key: string, label: string, pick: (l: PiListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
    lineTextColumn<T, PiListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden });
  const money = (key: string, label: string, pick: (l: PiListLine) => number | null, hidden = false) =>
    lineSumColumn<T, PiListLine>({
      key, label, linesOf, pick, exportFormat: "money", toExport: (sen) => senToRinggit(sen, 2), format: (sum) => fmtSen(sum), defaultHidden: hidden,
    });
  const rate = (key: string, label: string, pick: (l: PiListLine) => number | null, hidden = false): Column<T, PiListLine> => ({
    ...lineTextColumn<T, PiListLine>({
      key, label, linesOf, width: "120px", defaultHidden: hidden,
      pick: (l) => { const v = pick(l); return v === null ? null : String(v); },
      format: (v) => fmtSen(Number(v)),
    }),
    lineValue: (_r, l) => senToRinggit(pick(l), 4),
    exportFormat: "rate",
  });
  /* AutoCount's columns that hold no value in this ERP: blank cells, AutoCount's shape. */
  const blank = (key: string, label: string) => text(key, label, () => null, { width: "90px" });

  return {
    item_code: text("item_code", L.itemCode, (l) => l.ac_item_code, { width: "200px", mono: true }),
    detail_description: text("detail_description", L.detailDescription, (l) => l.book_description, { width: "240px" }),
    detail_description_2: text("detail_description_2", L.detailDescription2, (l) => l.description2, { width: "240px" }),
    uom: text("uom", L.uom, (l) => l.book_uom, { width: "80px" }),
    location: text("location", L.location, (l) => l.location, { width: "90px" }),
    proj_no: blank("proj_no", L.projNo),
    qty: lineSumColumn<T, PiListLine>({ key: "qty", label: L.qty, linesOf, pick: (l) => l.qty, exportFormat: "number" }),
    unit_price: rate("unit_price", L.unitPrice, (l) => l.unit_price_sen),
    discount: money("discount", L.discount, (l) => l.discount_sen),
    line_total: money("line_total", L.lineTotal, (l) => l.line_total_sen),
    tax_code: blank("tax_code", L.taxCode),
    line_tax: blank("line_tax", L.lineTax),
    /* No line tax in this ERP: Total (Ex) and Total (Inc) are the line total. */
    total_ex: money("total_ex", L.totalEx, (l) => l.line_total_sen),
    total_inc: money("total_inc", L.totalInc, (l) => l.line_total_sen),
    desc2: blank("desc2", L.desc2),

    item_group: text("item_group", L.itemGroup, (l) => l.book_item_group, { width: "110px", hidden: true }),
    our_po_no: text("our_po_no", L.ourPoNo, (l) => l.our_po_no, { width: "130px", mono: true, hidden: true }),
    erp_item_code: text("erp_item_code", L.erpItemCode, (l) => l.item_code, { width: "180px", mono: true, hidden: true }),
    supplier_sku: text("supplier_sku", L.supplierSku, (l) => l.supplier_sku, { width: "180px", mono: true, hidden: true }),
    po_unit_price: rate("po_unit_price", L.poUnitPrice, (l) => l.po_unit_price_sen, true),
    grn_no: text("grn_no", L.grnNo, (l) => l.grn_no, { width: "150px", mono: true, hidden: true }),
    po_no: text("po_no", L.poNo, (l) => l.po_no, { width: "150px", mono: true, hidden: true }),
    so_doc_no: text("so_doc_no", L.soDocNo, (l) => l.so_doc_no, { width: "150px", mono: true, hidden: true }),
    remarks: text("remarks", L.remarks, (l) => l.remarks, { width: "200px", hidden: true }),
    line_id: text("line_id", L.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}
