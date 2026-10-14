// ----------------------------------------------------------------------------
// pos-report.ts — the end-of-event summary email HTML on top of the shared
// aggregation (scm/shared/pos-report.ts, which the device and the ERP page
// use as well). The tables come from the shared report rows, so the email,
// the CSV, the device and the ERP page name the same columns.
// ----------------------------------------------------------------------------
import { fmtSen } from "../../scm/shared/format";
import { aggregateSales, reportRows, summaryCsv, type ReportSale, type ReportTotals } from "../../scm/shared/pos-report";

export { aggregateSales, summaryCsv };
export type { ReportSale, ReportTotals };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One block of the shared rows (its header row until the next blank row) as an HTML table. */
function block(rows: (string | number)[][], firstCell: string, limit = Infinity): string {
  const start = rows.findIndex((r) => r[0] === firstCell);
  if (start < 0) return "";
  const body: (string | number)[][] = [];
  for (let i = start + 1; i < rows.length && rows[i].length > 0 && body.length < limit; i += 1) body.push(rows[i]);
  const head = rows[start];
  return `<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr>${head.map((h) => `<th align="left" style="border-bottom:1px solid #ccc">${esc(String(h))}</th>`).join("")}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</table>`;
}

export function summaryHtml(eventName: string, t: ReportTotals): string {
  const rows = reportRows(eventName, t);
  return `<div style="font-family:Arial,sans-serif;color:#222">
<h2 style="margin:0 0 8px">POS summary · ${esc(eventName)}</h2>
<p><b>${t.bills}</b> bills · net sales <b>${fmtSen(t.net_sen)}</b> · discount ${fmtSen(t.discount_sen)} · SST ${fmtSen(t.sst_sen)} · void ${t.void_count} (${fmtSen(t.void_sen)}) · return ${t.return_count} (${fmtSen(t.return_sen)}) · FOC units ${t.foc_units}</p>
<h3>By payment method</h3>${block(rows, "By payment method")}
<h3>By salesman</h3>${block(rows, "By salesman")}
<h3>Per terminal</h3>${block(rows, "By terminal")}
<h3>Top 10 items</h3>${block(rows, "By item", 10)}
<p style="color:#777;font-size:12px">The attached CSV opens in Excel with every table above, the by-day split, the full item list and the void / return lists.</p></div>`;
}
