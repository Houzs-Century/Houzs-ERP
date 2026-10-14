// ----------------------------------------------------------------------------
// pos-report.ts — the one aggregation behind the end-of-event summary email
// (spec section 10), the ERP Sales Report (E6) and the POS daily report
// (P13): bills, net sales, by payment method, by salesman, by day, by item,
// by terminal, void / return counts, FOC units, top items. Pure; sen.
// ----------------------------------------------------------------------------
import { posReceiptStatusLabel } from "../../scm/shared/pos-vocabulary";

export type ReportSale = {
  uuid: string; type: string; status: string; receipt_no: string; terminal_code: string; sold_at: string;
  cashier_name: string | null; salesman_name: string | null; subtotal_sen: number; item_discount_sen: number; bill_discount_sen: number; sst_amount_sen: number; total_sen: number; is_test: boolean;
  lines: { item_code: string; description: string; qty: number; unit_price_sen: number; discount_amount_sen: number; is_foc: boolean; amount_sen: number }[];
  payments: { method: string; amount_sen: number }[];
};

export type ReportTotals = {
  bills: number; net_sen: number; gross_sen: number; discount_sen: number; sst_sen: number; void_count: number; void_sen: number; return_count: number; return_sen: number; foc_units: number; units: number;
  by_method: { method: string; amount_sen: number }[];
  by_salesman: { salesman: string; bills: number; net_sen: number }[];
  by_day: { day: string; bills: number; net_sen: number; by_method: Record<string, number> }[];
  by_terminal: { terminal: string; bills: number; net_sen: number }[];
  by_item: { item_code: string; description: string; qty: number; foc_qty: number; gross_sen: number; discount_sen: number; net_sen: number }[];
  top_items: { item_code: string; description: string; qty: number; net_sen: number }[];
};

const mytDay = (iso: string): string => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);

export function aggregateSales(sales: readonly ReportSale[]): ReportTotals {
  const t: ReportTotals = { bills: 0, net_sen: 0, gross_sen: 0, discount_sen: 0, sst_sen: 0, void_count: 0, void_sen: 0, return_count: 0, return_sen: 0, foc_units: 0, units: 0, by_method: [], by_salesman: [], by_day: [], by_terminal: [], by_item: [], top_items: [] };
  const method = new Map<string, number>();
  const salesman = new Map<string, { bills: number; net_sen: number }>();
  const day = new Map<string, { bills: number; net_sen: number; by_method: Record<string, number> }>();
  const terminal = new Map<string, { bills: number; net_sen: number }>();
  const item = new Map<string, ReportTotals["by_item"][number]>();
  for (const s of sales) {
    if (s.is_test) continue;
    const word = posReceiptStatusLabel(s);
    if (word === "VOID") { t.void_count += 1; t.void_sen += Math.abs(s.total_sen); continue; }
    const isReturn = word === "RETURN";
    const net = s.total_sen;
    if (isReturn) { t.return_count += 1; t.return_sen += -net; } else { t.bills += 1; t.gross_sen += s.subtotal_sen; t.discount_sen += s.item_discount_sen + s.bill_discount_sen; t.sst_sen += s.sst_amount_sen; }
    t.net_sen += net;
    for (const p of s.payments) method.set(p.method, (method.get(p.method) ?? 0) + p.amount_sen);
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
  t.by_method = Array.from(method, ([m, amount_sen]) => ({ method: m, amount_sen })).sort((a, b) => b.amount_sen - a.amount_sen);
  t.by_salesman = Array.from(salesman, ([s, v]) => ({ salesman: s, ...v })).sort((a, b) => b.net_sen - a.net_sen);
  t.by_day = Array.from(day, ([d, v]) => ({ day: d, ...v })).sort((a, b) => a.day.localeCompare(b.day));
  t.by_terminal = Array.from(terminal, ([c, v]) => ({ terminal: c, ...v })).sort((a, b) => a.terminal.localeCompare(b.terminal));
  t.by_item = Array.from(item.values()).sort((a, b) => b.net_sen - a.net_sen);
  t.top_items = t.by_item.slice(0, 10).map((i) => ({ item_code: i.item_code, description: i.description, qty: i.qty, net_sen: i.net_sen }));
  return t;
}

const rm = (sen: number): string => (sen / 100).toFixed(2);
const csvCell = (v: string | number): string => (typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The summary as a CSV workbook (opens in Excel): one block per table. */
export function summaryCsv(eventName: string, t: ReportTotals): string {
  const rows: (string | number)[][] = [
    ["Houzs POS summary", eventName], [],
    ["Bills", t.bills], ["Net sales (RM)", rm(t.net_sen)], ["Gross (RM)", rm(t.gross_sen)], ["Discount (RM)", rm(t.discount_sen)], ["SST (RM)", rm(t.sst_sen)],
    ["Void", t.void_count, rm(t.void_sen)], ["Return", t.return_count, rm(t.return_sen)], ["FOC units", t.foc_units], [],
    ["By payment method", "Amount (RM)"], ...t.by_method.map((m) => [m.method, rm(m.amount_sen)]), [],
    ["By salesman", "Bills", "Net (RM)"], ...t.by_salesman.map((s) => [s.salesman, s.bills, rm(s.net_sen)]), [],
    ["By day", "Bills", "Net (RM)"], ...t.by_day.map((d) => [d.day, d.bills, rm(d.net_sen)]), [],
    ["By terminal", "Bills", "Net (RM)"], ...t.by_terminal.map((x) => [x.terminal, x.bills, rm(x.net_sen)]), [],
    ["Top 10 items", "Description", "Qty", "Net (RM)"], ...t.top_items.map((i) => [i.item_code, i.description, i.qty, rm(i.net_sen)]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function summaryHtml(eventName: string, t: ReportTotals): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const table = (head: string[], body: (string | number)[][]) =>
    `<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr>${head.map((h) => `<th align="left" style="border-bottom:1px solid #ccc">${esc(h)}</th>`).join("")}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</table>`;
  return `<div style="font-family:Arial,sans-serif;color:#222">
<h2 style="margin:0 0 8px">POS summary · ${esc(eventName)}</h2>
<p><b>${t.bills}</b> bills · net sales <b>RM ${rm(t.net_sen)}</b> · discount RM ${rm(t.discount_sen)} · SST RM ${rm(t.sst_sen)} · void ${t.void_count} (RM ${rm(t.void_sen)}) · return ${t.return_count} (RM ${rm(t.return_sen)}) · FOC units ${t.foc_units}</p>
<h3>By payment method</h3>${table(["Method", "RM"], t.by_method.map((m) => [m.method, rm(m.amount_sen)]))}
<h3>By salesman</h3>${table(["Salesman", "Bills", "Net RM"], t.by_salesman.map((s) => [s.salesman, s.bills, rm(s.net_sen)]))}
<h3>Per terminal</h3>${table(["Terminal", "Bills", "Net RM"], t.by_terminal.map((x) => [x.terminal, x.bills, rm(x.net_sen)]))}
<h3>Top 10 items</h3>${table(["Code", "Description", "Qty", "Net RM"], t.top_items.map((i) => [i.item_code, i.description, i.qty, rm(i.net_sen)]))}
<p style="color:#777;font-size:12px">The attached CSV opens in Excel with every table above and the by-day split.</p></div>`;
}
