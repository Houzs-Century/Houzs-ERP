/* The Sales Order and Delivery Order grids' LINE columns and MONEY columns
 * (owner 2026-09-15: one Export per list, one row per line, the columns the grid
 * shows, labels and values as AutoCount lists them, money in ringgit).
 *
 * Labels are AutoCount's own captions (vendor/scm/lib/so-line-export-columns.ts,
 * do-line-export-columns.ts). A LINE column is compact on a document's row and
 * writes each line's own value in the file (components/dataTableLineCells.tsx,
 * shared by every list that exports by line). A MONEY column keeps sen for
 * sorting and shows RM on screen; the file gets ringgit (`exportValue`), never
 * sen. The Delivery Order line shape carries no money at all. */

import { fmtDate, fmtSen } from "@2990s/shared";
import type { Column } from "../../components/DataTable";
import { lineSumColumn, lineTextColumn } from "../../components/dataTableLineCells";
import { SO_LABELS, senToRinggit, type SoListLine } from "../../vendor/scm/lib/so-line-export-columns";
import { DO_LABELS, type DoListLine } from "../../vendor/scm/lib/do-line-export-columns";

type Sen = number | null | undefined;

/** A document-level amount: sen to sort, RM on screen, ringgit in the file. */
export function moneyColumn<R, L>(spec: {
  key: string;
  label: string;
  sen: (row: R) => Sen;
  width?: string;
  group?: string;
  defaultHidden?: boolean;
  tone?: "ink" | "secondary";
  strong?: boolean;
}): Column<R, L> {
  return {
    key: spec.key,
    label: spec.label,
    group: spec.group,
    width: spec.width ?? "120px",
    align: "right",
    defaultHidden: spec.defaultHidden,
    disableSort: true,
    getValue: (r) => spec.sen(r) ?? 0,
    exportValue: (r) => senToRinggit(spec.sen(r) ?? 0, 2),
    exportFormat: "money",
    render: (r) => (
      <span className={`font-money text-[13px] ${spec.strong ? "font-semibold " : ""}${spec.tone === "secondary" ? "text-ink-secondary" : "text-ink"}`}>
        {fmtSen(spec.sen(r) ?? 0)}
      </span>
    ),
  };
}

export type FinanceSenRow = {
  mattress_sofa_sen?: number; bedframe_sen?: number; accessories_sen?: number; others_sen?: number; service_sen?: number;
  mattress_sofa_cost_sen?: number; bedframe_cost_sen?: number; accessories_cost_sen?: number; others_cost_sen?: number;
  service_cost_sen?: number; total_cost_sen?: number; total_margin_sen?: number; margin_pct_basis?: number;
};

const FINANCE_MONEY: Array<[keyof FinanceSenRow, string, string, "ink" | "secondary"]> = [
  ["mattress_sofa_sen", "Mattress/Sofa", "120px", "ink"],
  ["bedframe_sen", "Bedframe", "110px", "ink"],
  ["accessories_sen", "Accessories", "110px", "ink"],
  ["others_sen", "Others", "100px", "ink"],
  ["service_sen", "Service", "100px", "ink"],
  ["mattress_sofa_cost_sen", "Mattress/Sofa Cost", "140px", "secondary"],
  ["bedframe_cost_sen", "Bedframe Cost", "130px", "secondary"],
  ["accessories_cost_sen", "Accessories Cost", "140px", "secondary"],
  ["others_cost_sen", "Others Cost", "130px", "secondary"],
  ["service_cost_sen", "Service Cost", "130px", "secondary"],
  ["total_cost_sen", "Total Cost", "120px", "secondary"],
  ["total_margin_sen", "Margin", "120px", "ink"],
];

/** The finance-viewer columns (per-category revenue and cost, margin), hidden
 *  by default. DECLARED ONLY for a finance viewer by the page; the backend also
 *  omits these keys for anyone else (canViewScmFinance). */
export function financeColumns<R extends FinanceSenRow, L>(group: string | undefined): Column<R, L>[] {
  return [
    ...FINANCE_MONEY.map(([key, label, width, tone]) =>
      moneyColumn<R, L>({ key, label, width, tone, group, defaultHidden: true, sen: (r) => r[key] })),
    {
      key: "margin_pct_basis",
      group,
      label: "Margin %",
      width: "100px",
      align: "right",
      defaultHidden: true,
      disableSort: true,
      getValue: (r) => r.margin_pct_basis ?? 0,
      exportValue: (r) => (r.margin_pct_basis == null ? null : r.margin_pct_basis / 100),
      exportFormat: "number",
      render: (r) => (
        <span className="font-money text-[13px] text-ink-secondary">
          {r.margin_pct_basis == null ? "—" : `${(r.margin_pct_basis / 100).toFixed(1)}%`}
        </span>
      ),
    },
  ];
}

/** A line unit price: RM on screen, ringgit with up to 4 places in the file. */
function unitPriceColumn<R extends { lines?: L[] }, L extends { unit_price_sen: number | null }>(key: string, label: string, group: string | undefined): Column<R, L> {
  return {
    ...lineTextColumn<R, L>({
      key, label, width: "130px", group, linesOf: (r) => r.lines ?? [],
      pick: (l) => (l.unit_price_sen === null ? null : String(l.unit_price_sen)),
      format: (v) => fmtSen(Number(v)),
    }),
    lineValue: (_r, l) => senToRinggit(l.unit_price_sen, 4),
    exportFormat: "rate",
  };
}

/** The Sales Order grid's line columns, keyed. The page decides the order;
 *  `hidden` names the ones not in AutoCount's "SALES ORDER DETAILS-SALES". */
export function soLineColumns<R extends { lines?: SoListLine[] }>(): Record<string, Column<R, SoListLine>> {
  const linesOf = (r: R): readonly SoListLine[] => r.lines ?? [];
  const text = (key: string, label: string, pick: (l: SoListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
    lineTextColumn<R, SoListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden, group: "Lines" });
  const date = (key: string, label: string, pick: (l: SoListLine) => string | null) =>
    lineTextColumn<R, SoListLine>({ key, label, linesOf, pick, width: "130px", exportFormat: "date", format: (v) => fmtDate(v), defaultHidden: true, group: "Lines" });
  const count = (key: string, label: string, pick: (l: SoListLine) => number | null, hidden: boolean) =>
    lineSumColumn<R, SoListLine>({ key, label, linesOf, pick, exportFormat: "number", defaultHidden: hidden, group: "Lines" });
  const money = (key: string, label: string, pick: (l: SoListLine) => number | null) =>
    lineSumColumn<R, SoListLine>({
      key, label, linesOf, pick, exportFormat: "money", toExport: (sen) => senToRinggit(sen, 2), format: (sum) => fmtSen(sum),
      defaultHidden: true, group: "Lines",
    });
  return {
    item_group: text("item_group", SO_LABELS.itemGroup, (l) => l.item_group, { width: "120px" }),
    item_code: text("item_code", SO_LABELS.itemCode, (l) => l.item_code, { width: "200px", mono: true }),
    detail_description: text("detail_description", SO_LABELS.detailDescription, (l) => l.description, { width: "240px" }),
    detail_description_2: text("detail_description_2", SO_LABELS.detailDescription2, (l) => l.description2, { width: "240px" }),
    uom: text("uom", SO_LABELS.uom, (l) => l.uom, { width: "90px" }),
    unit_price: unitPriceColumn<R, SoListLine>("unit_price", SO_LABELS.unitPrice, "Lines"),
    qty: count("qty", SO_LABELS.qty, (l) => l.qty, false),
    line_location: text("line_location", SO_LABELS.location, (l) => l.location, { width: "100px" }),
    discount: money("discount", SO_LABELS.discount, (l) => l.discount_sen),
    line_total: money("line_total", SO_LABELS.lineTotal, (l) => l.total_sen),
    delivered_qty: count("delivered_qty", SO_LABELS.deliveredQty, (l) => l.delivered_qty, true),
    returned_qty: count("returned_qty", SO_LABELS.returnedQty, (l) => l.returned_qty, true),
    remaining_qty: count("remaining_qty", SO_LABELS.remainingQty, (l) => l.remaining_qty, true),
    on_delivery_order_qty: count("on_delivery_order_qty", SO_LABELS.onDeliveryOrderQty, (l) => l.on_delivery_order_qty, true),
    po_delivery_date: date("po_delivery_date", SO_LABELS.poDeliveryDate, (l) => l.po_delivery_date),
    remarks: text("remarks", SO_LABELS.remarks, (l) => l.remark, { width: "200px", hidden: true }),
    erp_item_code: text("erp_item_code", SO_LABELS.erpItemCode, (l) => l.erp_item_code, { width: "180px", mono: true, hidden: true }),
    line_id: text("line_id", SO_LABELS.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}

/** The Delivery Order grid's line columns, keyed. No price or amount exists on
 *  a delivery order line (owner 2026-09-15). */
export function doLineColumns<R extends { lines?: DoListLine[] }>(): Record<string, Column<R, DoListLine>> {
  const linesOf = (r: R): readonly DoListLine[] => r.lines ?? [];
  const text = (key: string, label: string, pick: (l: DoListLine) => string | null, o: { width?: string; mono?: boolean; hidden?: boolean } = {}) =>
    lineTextColumn<R, DoListLine>({ key, label, linesOf, pick, width: o.width, mono: o.mono, defaultHidden: o.hidden });
  const count = (key: string, label: string, pick: (l: DoListLine) => number | null, hidden: boolean) =>
    lineSumColumn<R, DoListLine>({ key, label, linesOf, pick, exportFormat: "number", defaultHidden: hidden });
  return {
    item_code: text("item_code", DO_LABELS.itemCode, (l) => l.item_code, { width: "200px", mono: true }),
    detail_description: text("detail_description", DO_LABELS.detailDescription, (l) => l.description, { width: "240px" }),
    detail_description_2: text("detail_description_2", DO_LABELS.detailDescription2, (l) => l.description2, { width: "240px" }),
    uom: text("uom", DO_LABELS.uom, (l) => l.uom, { width: "90px" }),
    line_location: text("line_location", DO_LABELS.location, (l) => l.location, { width: "100px" }),
    qty: count("qty", DO_LABELS.qty, (l) => l.qty, false),
    po_doc_no: text("po_doc_no", DO_LABELS.poDocNo, (l) => l.po_nos.join(", ") || null, { width: "150px", mono: true }),
    item_group: text("item_group", DO_LABELS.itemGroup, (l) => l.item_group, { width: "120px" }),
    invoiced_qty: count("invoiced_qty", DO_LABELS.invoicedQty, (l) => l.invoiced_qty, true),
    returned_qty: count("returned_qty", DO_LABELS.returnedQty, (l) => l.returned_qty, true),
    uninvoiced_qty: count("uninvoiced_qty", DO_LABELS.uninvoicedQty, (l) => l.uninvoiced_qty, true),
    m3: count("m3", DO_LABELS.m3, (l) => l.m3, true),
    remarks: text("remarks", DO_LABELS.remarks, (l) => l.remark, { width: "200px", hidden: true }),
    erp_item_code: text("erp_item_code", DO_LABELS.erpItemCode, (l) => l.erp_item_code, { width: "180px", mono: true, hidden: true }),
    line_id: text("line_id", DO_LABELS.lineId, (l) => l.id, { width: "300px", mono: true, hidden: true }),
  };
}
