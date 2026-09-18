/* The Sales Invoices grid's LINE columns (owner 2026-09-15: "exactly like
 * AutoCount — one row per line, the columns I choose").
 *
 * On screen each is compact per invoice (components/dataTableLineCells.tsx, the
 * one renderer every line-exporting list shares); in the export each line gets
 * its own row and cell. Labels are AutoCount's Sales Invoice Detail Listing
 * captions (SI_LABELS). Values arrive spelled the AutoCount way from the server
 * (lib/si-export-rows.ts). Money is sen on screen, ringgit in the file. */

import { fmtDate, fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { SI_LABELS as L, senToRinggit, type SiListLine } from "../../vendor/scm/lib/si-list-export";

export type SiGridRow = { id: string; lines?: SiListLine[] };

export function siLineColumns<T extends SiGridRow>(): Record<string, Column<T, SiListLine>> {
  const linesOf = (r: T): readonly SiListLine[] => r.lines ?? [];
  const text = (key: string, label: string, pick: (l: SiListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
    lineTextColumn<T, SiListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden });
  const money = (key: string, label: string, pick: (l: SiListLine) => number | null, hidden = false) =>
    lineSumColumn<T, SiListLine>({
      key, label, linesOf, pick, exportFormat: "money", toExport: (sen) => senToRinggit(sen, 2), format: (sum) => fmtSen(sum), defaultHidden: hidden,
    });
  const rate = (key: string, label: string, pick: (l: SiListLine) => number | null, hidden = false): Column<T, SiListLine> => ({
    ...lineTextColumn<T, SiListLine>({
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
    qty: lineSumColumn<T, SiListLine>({ key: "qty", label: L.qty, linesOf, pick: (l) => l.qty, exportFormat: "number" }),
    unit_price: rate("unit_price", L.unitPrice, (l) => l.unit_price_sen),
    discount: money("discount", L.discount, (l) => l.discount_sen),
    line_total: money("line_total", L.lineTotal, (l) => l.line_total_sen),
    tax_code: blank("tax_code", L.taxCode),
    line_tax: blank("line_tax", L.lineTax),
    /* The ERP keeps no line tax on a sales invoice: Total (Ex) and Total (Inc) are
       the line total. */
    total_ex: money("total_ex", L.totalEx, (l) => l.line_total_sen),
    total_inc: money("total_inc", L.totalInc, (l) => l.line_total_sen),
    desc2: blank("desc2", L.desc2),

    item_group: text("item_group", L.itemGroup, (l) => l.book_item_group, { width: "110px", hidden: true }),
    delivery_date: lineTextColumn<T, SiListLine>({
      key: "delivery_date", label: L.deliveryDate, linesOf, width: "120px", defaultHidden: true,
      pick: (l) => l.delivery_date, exportFormat: "date", format: (v) => fmtDate(v),
    }),
    do_no: text("do_no", L.doNo, (l) => l.do_no, { width: "150px", mono: true, hidden: true }),
    erp_item_code: text("erp_item_code", L.erpItemCode, (l) => l.item_code, { width: "180px", mono: true, hidden: true }),
    remarks: text("remarks", L.remarks, (l) => l.remarks, { width: "200px", hidden: true }),
    line_id: text("line_id", L.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}
