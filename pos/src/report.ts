/* The device's Sales report (layout P13): which local bills fall in the
 * chosen range, the shared aggregation over them, the thermal Z-report
 * lines, the printable HTML (Save as PDF) and the Excel rows. Works offline
 * from IndexedDB; "all terminals" asks the ERP when it is reachable. */
import { aggregateSales, reportRows, type ReportSale, type ReportTotals } from "@shared/pos-report";
export { reportHtml } from "@shared/pos-report";
import { posMethodLabel } from "@shared/pos-vocabulary";
import { center, lr, receiptColumns, type ReceiptLine } from "./receipt";
import { mytDate, type SaleRecord } from "./sale";
import type { DeviceState } from "./types";

export type ReportRange = { kind: "today" } | { kind: "date"; date: string } | { kind: "range"; from: string; to: string } | { kind: "event" };

/** The Malaysia-day bounds of a range: [from, to] inclusive, as yyyy-mm-dd. */
export function rangeDays(r: ReportRange, event: { start_date: string | null; end_date: string | null }, todayIso: string): { from: string; to: string; label: string } {
  const today = mytDate(todayIso);
  if (r.kind === "today") return { from: today, to: today, label: `Today ${today}` };
  if (r.kind === "date") return { from: r.date, to: r.date, label: r.date };
  if (r.kind === "range") {
    /* Typed backwards is still a range: the owner picks two days, not an order. */
    const [from, to] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from];
    return { from, to, label: from === to ? from : `${from} to ${to}` };
  }
  const from = event.start_date?.slice(0, 10) ?? "0000-01-01";
  const to = event.end_date?.slice(0, 10) ?? "9999-12-31";
  return { from, to, label: `Full event ${from} to ${to}` };
}

export const inRange = (s: { sold_at: string }, days: { from: string; to: string }): boolean => {
  const d = mytDate(s.sold_at);
  return d >= days.from && d <= days.to;
};

/** A device bill in the shape the shared aggregation reads. */
export function toReportSale(s: SaleRecord): ReportSale {
  return {
    uuid: s.uuid, type: s.type, status: s.status, receipt_no: s.receipt_no, terminal_code: s.terminal_code, sold_at: s.sold_at, cashier_name: s.cashier_name, salesman_name: s.salesman_name,
    subtotal_sen: s.subtotal_sen, item_discount_sen: s.item_discount_sen, bill_discount_sen: s.bill_discount_sen, sst_amount_sen: s.sst_amount_sen, total_sen: s.total_sen, is_test: s.is_test,
    void_reason: s.void_reason, ref_receipt_no: s.ref_receipt_no,
    lines: s.lines.map((l) => ({ item_code: l.code, description: l.description, qty: l.qty, unit_price_sen: l.unit_price_sen, discount_amount_sen: l.discount_amount_sen, is_foc: l.is_foc, amount_sen: l.amount_sen })),
    payments: s.payments.map((p) => ({ method: p.method, amount_sen: p.amount_sen })),
  };
}

export const localReport = (sales: readonly SaleRecord[], days: { from: string; to: string }): ReportTotals => aggregateSales(sales.filter((s) => inRange(s, days)).map(toReportSale));

const rm = (sen: number): string => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));

/** The daily report in thermal Z-report form: event / terminal / date,
 *  KPIs, by method with refunds, by salesman, void and return lists, FOC,
 *  top items. Re-printable any time; there is no close-counter step. */
export function zReportLines(t: ReportTotals, ctx: { state: DeviceState; scope: string; rangeLabel: string; printedAt: string }): ReceiptLine[] {
  const w = receiptColumns(ctx.state.bundle.settings.sst_receipt.paper_width);
  const rule = "-".repeat(w);
  const out: ReceiptLine[] = [
    { text: ctx.state.bundle.company.name, bold: true, center: true },
    { text: "SALES REPORT", bold: true, center: true, big: true },
    { text: center(ctx.state.bundle.event.name, w) },
    { text: lr(ctx.scope, ctx.rangeLabel, w) },
    { text: lr("Printed", ctx.printedAt, w) },
    { text: rule },
    { text: lr("Bills", String(t.bills), w) },
    { text: lr("Gross", rm(t.gross_sen), w) },
    { text: lr("Discount", `-${rm(t.discount_sen)}`, w) },
    { text: lr("SST", rm(t.sst_sen), w) },
    { text: lr("Returns", `-${rm(t.return_sen)}`, w) },
    { text: lr("NET SALES", rm(t.net_sen), w), bold: true },
    { text: lr("Void (not counted)", `${t.void_count} / ${rm(t.void_sen)}`, w) },
    { text: lr("FOC units", String(t.foc_units), w) },
    { text: rule },
    { text: "BY PAYMENT METHOD", bold: true },
  ];
  for (const m of t.by_method) {
    out.push({ text: lr(posMethodLabel(m.method), rm(m.sales_sen), w) });
    if (m.refund_sen > 0) out.push({ text: lr(`  refunds`, `-${rm(m.refund_sen)}`, w) });
  }
  out.push({ text: lr("NET RECEIVED", rm(t.by_method.reduce((n, m) => n + m.amount_sen, 0)), w), bold: true });
  out.push({ text: rule }, { text: "BY SALESMAN", bold: true });
  for (const s of t.by_salesman) out.push({ text: lr(`${s.salesman} (${s.bills})`, rm(s.net_sen), w) });
  if (t.voids.length) {
    out.push({ text: rule }, { text: "VOID", bold: true });
    for (const v of t.voids) out.push({ text: lr(v.receipt_no, rm(v.total_sen), w) }, { text: `  ${v.reason}`.slice(0, w) });
  }
  if (t.returns.length) {
    out.push({ text: rule }, { text: "RETURN", bold: true });
    for (const r of t.returns) out.push({ text: lr(`${r.receipt_no}${r.ref ? ` <${r.ref}` : ""}`, rm(r.total_sen), w) });
  }
  out.push({ text: rule }, { text: "TOP ITEMS", bold: true });
  for (const i of t.top_items) out.push({ text: lr(`${i.qty} x ${i.description}`.slice(0, w - 10), rm(i.net_sen), w) });
  out.push({ text: rule }, { text: center("Test sales excluded", w) }, { text: " " }, { text: " " });
  return out;
}

/** Excel: one sheet of the shared rows (lazy library, never in the shell). */
export async function downloadReportXlsx(title: string, t: ReportTotals, fileName: string): Promise<void> {
  const writeXlsxFile = (await import("write-excel-file")).default;
  const rows = reportRows(title, t).map((r) => r.map((c) => (typeof c === "number" ? { value: c, type: Number } : { value: c, type: String })));
  await writeXlsxFile(rows, { fileName, columns: [{ width: 26 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }] });
}
