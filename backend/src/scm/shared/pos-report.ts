/* The one aggregation behind every Houzs POS report: the device's Sales
 * report and thermal Z-report (layout P13), the ERP Sales Report (E6) and
 * the end-of-event summary email. Bills, net sales, by payment method with
 * refunds split out (for tallying with the bank / terminal settlement), by
 * salesman, by day, by item, by terminal, void / return lists, FOC units,
 * top items. Pure; money in sen; test sales are never counted.
 *
 * ONE home. backend/src/scm/shared/pos-report.ts is the original and
 * frontend/src/vendor/shared/pos-report.ts its byte-identical copy
 * (check-shared-mirrors.mjs); the POS app imports the vendored copy.
 */
import { posReceiptStatusLabel } from "./pos-vocabulary";

export type ReportSale = {
  uuid: string; type: string; status: string; receipt_no: string; terminal_code: string; sold_at: string;
  cashier_name: string | null; salesman_name: string | null; subtotal_sen: number; item_discount_sen: number; bill_discount_sen: number; sst_amount_sen: number; total_sen: number; is_test: boolean;
  void_reason?: string | null; ref_receipt_no?: string | null;
  lines: { item_code: string; description: string; qty: number; unit_price_sen: number; discount_amount_sen: number; is_foc: boolean; amount_sen: number }[];
  payments: { method: string; amount_sen: number }[];
};

export type ReportTotals = {
  bills: number; net_sen: number; gross_sen: number; discount_sen: number; sst_sen: number; void_count: number; void_sen: number; return_count: number; return_sen: number; foc_units: number; units: number;
  /** amount_sen = net received (sales minus refunds). */
  by_method: { method: string; amount_sen: number; sales_sen: number; refund_sen: number }[];
  by_salesman: { salesman: string; bills: number; net_sen: number }[];
  by_day: { day: string; bills: number; net_sen: number; by_method: Record<string, number> }[];
  by_terminal: { terminal: string; bills: number; net_sen: number }[];
  by_item: { item_code: string; description: string; qty: number; foc_qty: number; gross_sen: number; discount_sen: number; net_sen: number }[];
  top_items: { item_code: string; description: string; qty: number; net_sen: number }[];
  voids: { receipt_no: string; total_sen: number; reason: string; by: string }[];
  returns: { receipt_no: string; total_sen: number; ref: string }[];
};

const mytDay = (iso: string): string => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);

export function aggregateSales(sales: readonly ReportSale[]): ReportTotals {
  const t: ReportTotals = { bills: 0, net_sen: 0, gross_sen: 0, discount_sen: 0, sst_sen: 0, void_count: 0, void_sen: 0, return_count: 0, return_sen: 0, foc_units: 0, units: 0, by_method: [], by_salesman: [], by_day: [], by_terminal: [], by_item: [], top_items: [], voids: [], returns: [] };
  const method = new Map<string, { sales_sen: number; refund_sen: number }>();
  const salesman = new Map<string, { bills: number; net_sen: number }>();
  const day = new Map<string, { bills: number; net_sen: number; by_method: Record<string, number> }>();
  const terminal = new Map<string, { bills: number; net_sen: number }>();
  const item = new Map<string, ReportTotals["by_item"][number]>();
  for (const s of sales) {
    if (s.is_test) continue;
    const word = posReceiptStatusLabel(s);
    if (word === "VOID") { t.void_count += 1; t.void_sen += Math.abs(s.total_sen); t.voids.push({ receipt_no: s.receipt_no, total_sen: s.total_sen, reason: s.void_reason ?? "", by: s.cashier_name ?? "" }); continue; }
    const isReturn = word === "RETURN";
    const net = s.total_sen;
    if (isReturn) { t.return_count += 1; t.return_sen += -net; t.returns.push({ receipt_no: s.receipt_no, total_sen: s.total_sen, ref: s.ref_receipt_no ?? "" }); } else { t.bills += 1; t.gross_sen += s.subtotal_sen; t.discount_sen += s.item_discount_sen + s.bill_discount_sen; t.sst_sen += s.sst_amount_sen; }
    t.net_sen += net;
    for (const p of s.payments) {
      const mv = method.get(p.method) ?? { sales_sen: 0, refund_sen: 0 };
      if (p.amount_sen < 0) mv.refund_sen += -p.amount_sen; else mv.sales_sen += p.amount_sen;
      method.set(p.method, mv);
    }
    const sm = s.salesman_name ?? "Booth";
    const smv = salesman.get(sm) ?? { bills: 0, net_sen: 0 };
    smv.bills += isReturn ? 0 : 1; smv.net_sen += net; salesman.set(sm, smv);
    const d = mytDay(s.sold_at);
    const dv = day.get(d) ?? { bills: 0, net_sen: 0, by_method: {} };
    dv.bills += isReturn ? 0 : 1; dv.net_sen += net;
    for (const p of s.payments) dv.by_method[p.method] = (dv.by_method[p.method] ?? 0) + p.amount_sen;
    day.set(d, dv);
    const tv = terminal.get(s.terminal_code) ?? { bills: 0, net_sen: 0 };
    tv.bills += isReturn ? 0 : 1; tv.net_sen += net; terminal.set(s.terminal_code, tv);
    for (const l of s.lines) {
      const iv = item.get(l.item_code) ?? { item_code: l.item_code, description: l.description, qty: 0, foc_qty: 0, gross_sen: 0, discount_sen: 0, net_sen: 0 };
      if (l.is_foc) { iv.foc_qty += l.qty; t.foc_units += l.qty; } else { iv.qty += l.qty; iv.gross_sen += l.qty * l.unit_price_sen; iv.discount_sen += l.discount_amount_sen; iv.net_sen += l.amount_sen; }
      t.units += l.qty;
      item.set(l.item_code, iv);
    }
  }
  t.by_method = Array.from(method, ([m, v]) => ({ method: m, amount_sen: v.sales_sen - v.refund_sen, ...v })).sort((a, b) => b.amount_sen - a.amount_sen);
  t.by_salesman = Array.from(salesman, ([s, v]) => ({ salesman: s, ...v })).sort((a, b) => b.net_sen - a.net_sen);
  t.by_day = Array.from(day, ([d, v]) => ({ day: d, ...v })).sort((a, b) => a.day.localeCompare(b.day));
  t.by_terminal = Array.from(terminal, ([c, v]) => ({ terminal: c, ...v })).sort((a, b) => a.terminal.localeCompare(b.terminal));
  t.by_item = Array.from(item.values()).sort((a, b) => b.net_sen - a.net_sen);
  t.top_items = t.by_item.slice(0, 10).map((i) => ({ item_code: i.item_code, description: i.description, qty: i.qty, net_sen: i.net_sen }));
  return t;
}

/** A ringgit figure as a bare number for a CSV / spreadsheet cell. */
export const rmCell = (sen: number): string => (sen / 100).toFixed(2);
const csvCell = (v: string | number): string => (typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The report as rows of cells: one block per table, a blank row between.
 *  The CSV, the device's Excel export and the ERP's Excel export all come
 *  from this so the three agree. */
export function reportRows(title: string, t: ReportTotals): (string | number)[][] {
  return [
    ["Houzs POS report", title], [],
    ["Bills", t.bills], ["Net sales (RM)", rmCell(t.net_sen)], ["Gross (RM)", rmCell(t.gross_sen)], ["Discount (RM)", rmCell(t.discount_sen)], ["SST (RM)", rmCell(t.sst_sen)],
    ["Void", t.void_count, rmCell(t.void_sen)], ["Return", t.return_count, rmCell(t.return_sen)], ["FOC units", t.foc_units], [],
    ["By payment method", "Sales (RM)", "Refunds (RM)", "Net received (RM)"], ...t.by_method.map((m) => [m.method, rmCell(m.sales_sen), rmCell(m.refund_sen), rmCell(m.amount_sen)]), [],
    ["By salesman", "Bills", "Net (RM)"], ...t.by_salesman.map((s) => [s.salesman, s.bills, rmCell(s.net_sen)]), [],
    ["By day", "Bills", "Net (RM)", ...Object.keys(t.by_day.reduce<Record<string, true>>((acc, d) => { for (const k of Object.keys(d.by_method)) acc[k] = true; return acc; }, {}))],
    ...t.by_day.map((d) => [d.day, d.bills, rmCell(d.net_sen), ...Object.keys(t.by_day.reduce<Record<string, true>>((acc, x) => { for (const k of Object.keys(x.by_method)) acc[k] = true; return acc; }, {})).map((k) => rmCell(d.by_method[k] ?? 0))]), [],
    ["By terminal", "Bills", "Net (RM)"], ...t.by_terminal.map((x) => [x.terminal, x.bills, rmCell(x.net_sen)]), [],
    ["By item", "Description", "Qty", "FOC", "Gross (RM)", "Discount (RM)", "Net (RM)"], ...t.by_item.map((i) => [i.item_code, i.description, i.qty, i.foc_qty, rmCell(i.gross_sen), rmCell(i.discount_sen), rmCell(i.net_sen)]), [],
    ["Void", "Amount (RM)", "Reason", "By"], ...t.voids.map((v) => [v.receipt_no, rmCell(v.total_sen), v.reason, v.by]), [],
    ["Return", "Amount (RM)", "Original"], ...t.returns.map((r) => [r.receipt_no, rmCell(r.total_sen), r.ref]),
  ];
}

export function summaryCsv(title: string, t: ReportTotals): string {
  return reportRows(title, t).map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rmText = (sen: number): string => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));
const numeric = (c: string | number): boolean => typeof c === "number" || /^-?\d+\.\d\d$/.test(c);

/** One block of the report rows (its header row until the next blank row) as an HTML table. */
export function reportBlockHtml(rows: (string | number)[][], firstCell: string, limit = Infinity): string {
  const start = rows.findIndex((r) => r[0] === firstCell);
  if (start < 0) return "";
  const body: (string | number)[][] = [];
  for (let i = start + 1; i < rows.length && body.length < limit; i += 1) { const r = rows.at(i); if (!r || r.length === 0) break; body.push(r); }
  if (body.length === 0) return "";
  const head = rows.at(start) ?? [];
  return `<table><tr>${head.map((h) => `<th>${esc(String(h))}</th>`).join("")}</tr>${body.map((r) => `<tr>${r.map((c, i) => `<td class="${i > 0 && numeric(c) ? "n" : ""}">${esc(String(c))}</td>`).join("")}</tr>`).join("")}</table>`;
}

/** The report as a printable page (the Save as PDF of the browser), built
 *  from the same rows as the CSV and the Excel sheet. */
export function reportHtml(t: ReportTotals, ctx: { company: string; event: string; scope: string; rangeLabel: string; printedAt: string }): string {
  const rows = reportRows(ctx.event, t);
  const section = (title: string, firstCell: string) => { const h = reportBlockHtml(rows, firstCell); return h ? `<h2>${esc(title)}</h2>${h}` : ""; };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sales report ${esc(ctx.rangeLabel)}</title>
<style>body{font-family:Arial,sans-serif;color:#222;margin:24px;font-size:13px}h1{font-size:18px;margin:0}h2{font-size:13px;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.06em;color:#555}table{border-collapse:collapse;min-width:360px}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}th{font-size:11px;color:#666}td.n{text-align:right;font-variant-numeric:tabular-nums}.kpi{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0}.kpi div b{display:block;font-size:18px}@media print{body{margin:12px}}</style></head><body>
<h1>${esc(ctx.company)} · Sales report</h1><div>${esc(ctx.event)} · ${esc(ctx.scope)} · ${esc(ctx.rangeLabel)} · printed ${esc(ctx.printedAt)}</div>
<div class="kpi"><div>Bills<b>${t.bills}</b></div><div>Net sales<b>RM ${rmText(t.net_sen)}</b></div><div>Discount<b>RM ${rmText(t.discount_sen)}</b></div><div>Void<b>${t.void_count} / RM ${rmText(t.void_sen)}</b></div><div>Return<b>${t.return_count} / RM ${rmText(t.return_sen)}</b></div><div>FOC units<b>${t.foc_units}</b></div></div>
${section("By payment method", "By payment method")}
${section("By salesman", "By salesman")}
${section("By terminal", "By terminal")}
${section("Items", "By item")}
${section("Void", "Void")}
${section("Return", "Return")}
<p style="color:#777;font-size:11px">Test sales excluded. Amounts in RM.</p></body></html>`;
}
