/* POS Admin > Sales Report (layout E6): one event at a time. Filters date
 * range, terminal, salesman, status; KPIs; by day with the payment split;
 * by salesman (review only); by item with qty, FOC, gross, discount, net and
 * stock left at the event's stock location; by payment method with refunds
 * and net received. Export Excel (one sheet of the shared report rows plus
 * the stock column) and PDF (the shared printable page through the
 * browser's Save as PDF). The figures are the same aggregation the device
 * and the summary email use. */
import { useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";
import { fmtSen } from "../../vendor/shared/format";
import { reportHtml, reportRows, rmCell, type ReportTotals } from "../../vendor/shared/pos-report";
import { POS_PAYMENT_METHODS, posMethodLabel } from "../../vendor/shared/pos-vocabulary";
import { DateField } from "../../vendor/scm/components/DateField";
import { useAdminEvents, useSalesReport, type ReportFilter, type ReportResponse } from "./posAdminApi";
import { Empty, Field, Table, errText, ghostBtn, inputCls, td, th } from "./posAdminUi";

const EMPTY: ReportFilter = { project_id: null, from: "", to: "", terminal: "", salesman: "", status: "" };

/** The Excel rows: the shared report plus the stock-left column on the item block. */
export function reportXlsxRows(title: string, t: ReportTotals, stockLeft: Partial<Record<string, number>>): (string | number)[][] {
  const rows = reportRows(title, t);
  const head = rows.findIndex((r) => r[0] === "By item");
  if (head < 0) return rows;
  rows[head] = [...rows[head]!, "Stock left"];
  for (let i = head + 1; i < rows.length && rows[i]!.length > 0; i += 1) rows[i] = [...rows[i]!, stockLeft[String(rows[i]![0])] ?? 0];
  return rows;
}

async function exportXlsx(res: ReportResponse, title: string): Promise<void> {
  const writeXlsxFile = (await import("write-excel-file")).default;
  const rows = reportXlsxRows(title, res.totals, res.stock_left).map((r) => r.map((c) => (typeof c === "number" ? { value: c, type: Number } : { value: c, type: String })));
  await writeXlsxFile(rows, { fileName: `POS_Sales_Report_${title.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40)}.xlsx`, columns: [{ width: 26 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }] });
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="text-[18px] font-semibold leading-tight">{value}</div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

export function PosReportTab() {
  const toast = useToast();
  const events = useAdminEvents();
  const linked = useMemo(() => (events.data ?? []).filter((e) => e.link), [events.data]);
  const [filter, setFilter] = useState<ReportFilter>(EMPTY);
  const effective = useMemo<ReportFilter>(() => (filter.project_id == null && linked.length > 0 ? { ...filter, project_id: linked[0]!.project_id } : filter), [filter, linked]);
  const report = useSalesReport(effective);
  const [busy, setBusy] = useState(false);
  const d = report.data;
  const t = d?.totals;
  const title = d?.project ? `${d.project.name}${d.filter.from || d.filter.to ? ` ${d.filter.from ?? "start"} to ${d.filter.to ?? "end"}` : ""}${d.filter.terminal ? ` ${d.filter.terminal}` : ""}` : "";
  const set = (patch: Partial<ReportFilter>) => setFilter({ ...effective, ...patch });
  const methods = useMemo(() => {
    const seen = new Set<string>(t?.by_method.map((m) => m.method) ?? []);
    return POS_PAYMENT_METHODS.filter((m) => seen.has(m));
  }, [t]);

  async function doExcel() {
    if (!d) return;
    setBusy(true);
    try { await exportXlsx(d, title); } catch (e) { toast.error(errText(e, "Could not write the Excel file.")); } finally { setBusy(false); }
  }
  function doPdf() {
    if (!d || !t) return;
    const w = window.open("", "_blank");
    if (!w) { toast.error("Allow pop-ups to open the PDF page."); return; }
    w.document.write(reportHtml(t, { company: "Houzs", event: d.project?.name ?? "", scope: d.filter.terminal ?? "All terminals", rangeLabel: `${d.filter.from ?? "event start"} to ${d.filter.to ?? "event end"}`, printedAt: new Date().toLocaleString("en-MY") }));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <Field label="Event">
          <select className={cn(inputCls, "w-64")} value={effective.project_id ?? ""} onChange={(e) => set({ project_id: e.target.value ? Number(e.target.value) : null, terminal: "", salesman: "" })} aria-label="Event">
            {linked.length === 0 && <option value="">No event linked to POS</option>}
            {linked.map((e) => <option key={e.project_id} value={e.project_id}>{e.name}{e.start_date ? ` (${e.start_date}${e.end_date ? ` to ${e.end_date}` : ""})` : ""}</option>)}
          </select>
        </Field>
        <Field label="From"><DateField value={effective.from} onChange={(v) => set({ from: v })} className="w-32" aria-label="From date" /></Field>
        <Field label="To"><DateField value={effective.to} onChange={(v) => set({ to: v })} className="w-32" aria-label="To date" /></Field>
        <Field label="Terminal">
          <select className={cn(inputCls, "w-28")} value={effective.terminal} onChange={(e) => set({ terminal: e.target.value })} aria-label="Terminal"><option value="">All</option>{(d?.options.terminals ?? []).map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        <Field label="Salesman">
          <select className={cn(inputCls, "w-36")} value={effective.salesman} onChange={(e) => set({ salesman: e.target.value })} aria-label="Salesman"><option value="">All</option>{(d?.options.salesmen ?? []).map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        <Field label="Status">
          <select className={cn(inputCls, "w-28")} value={effective.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status"><option value="">All</option><option value="PAID">PAID</option><option value="RETURN">RETURN</option><option value="VOID">VOID</option></select>
        </Field>
        <span className="ml-auto flex gap-1">
          <button type="button" className={ghostBtn} disabled={!d || busy} onClick={() => void doExcel()}><Download size={11} /> Export Excel</button>
          <button type="button" className={ghostBtn} disabled={!d} onClick={doPdf}><Printer size={11} /> Export PDF</button>
        </span>
      </div>
      {report.error && <div className="mb-2 rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{report.error}</div>}
      {linked.length === 0 && events.data && <Empty>Link an event to POS first (Events tab); the report reads that event's synced bills.</Empty>}
      {report.loading && !d && linked.length > 0 && <div className="text-[11px] text-ink-muted">Loading report…</div>}
      {d && t && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
            <Kpi label="Bills" value={String(t.bills)} sub={`${d.count} receipt(s) incl. void / return`} />
            <Kpi label="Net sales" value={fmtSen(t.net_sen)} sub={`gross ${fmtSen(t.gross_sen)}`} />
            <Kpi label="Discount" value={fmtSen(t.discount_sen)} sub={`SST ${fmtSen(t.sst_sen)}`} />
            <Kpi label="Void" value={String(t.void_count)} sub={fmtSen(t.void_sen)} />
            <Kpi label="Return" value={String(t.return_count)} sub={fmtSen(t.return_sen)} />
            <Kpi label="FOC units" value={String(t.foc_units)} sub={`${t.units} units moved`} />
          </div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">By day</h3>
          {t.by_day.length === 0 ? <Empty>No bill in this range.</Empty> : (
            <Table minWidth={640} head={<><th className={th}>Day</th><th className={cn(th, "text-right")}>Bills</th>{methods.map((m) => <th key={m} className={cn(th, "text-right")}>{posMethodLabel(m)}</th>)}<th className={cn(th, "text-right")}>Net</th></>}>
              {t.by_day.map((row) => (
                <tr key={row.day} className="border-t border-border-subtle">
                  <td className={cn(td, "font-mono")}>{row.day}</td>
                  <td className={cn(td, "text-right")}>{row.bills}</td>
                  {methods.map((m) => <td key={m} className={cn(td, "text-right font-mono")}>{row.by_method[m] ? fmtSen(row.by_method[m]) : "--"}</td>)}
                  <td className={cn(td, "text-right font-mono font-semibold")}>{fmtSen(row.net_sen)}</td>
                </tr>
              ))}
            </Table>
          )}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">By payment method</h3>
              <Table minWidth={360} head={<><th className={th}>Method</th><th className={cn(th, "text-right")}>Sales</th><th className={cn(th, "text-right")}>Refunds</th><th className={cn(th, "text-right")}>Net received</th></>}>
                {t.by_method.map((m) => <tr key={m.method} className="border-t border-border-subtle"><td className={td}>{posMethodLabel(m.method)}</td><td className={cn(td, "text-right font-mono")}>{fmtSen(m.sales_sen)}</td><td className={cn(td, "text-right font-mono")}>{m.refund_sen ? fmtSen(-m.refund_sen) : "--"}</td><td className={cn(td, "text-right font-mono font-semibold")}>{fmtSen(m.amount_sen)}</td></tr>)}
              </Table>
            </div>
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">By salesman <span className="font-normal normal-case tracking-normal text-ink-muted">(review only)</span></h3>
              <Table minWidth={300} head={<><th className={th}>Salesman</th><th className={cn(th, "text-right")}>Bills</th><th className={cn(th, "text-right")}>Net</th></>}>
                {t.by_salesman.map((s) => <tr key={s.salesman} className="border-t border-border-subtle"><td className={td}>{s.salesman}</td><td className={cn(td, "text-right")}>{s.bills}</td><td className={cn(td, "text-right font-mono")}>{fmtSen(s.net_sen)}</td></tr>)}
              </Table>
            </div>
          </div>
          <h3 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">By item {d.stock_location ? "" : <span className="font-normal normal-case tracking-normal text-amber-800">(no stock location set: stock left is the company total)</span>}</h3>
          <Table minWidth={760} head={<><th className={th}>Code</th><th className={th}>Description</th><th className={cn(th, "text-right")}>Qty</th><th className={cn(th, "text-right")}>FOC</th><th className={cn(th, "text-right")}>Gross</th><th className={cn(th, "text-right")}>Discount</th><th className={cn(th, "text-right")}>Net</th><th className={cn(th, "text-right")}>Stock left</th></>}>
            {t.by_item.map((i) => {
              const left = d.stock_left[i.item_code];
              return (
                <tr key={i.item_code} className="border-t border-border-subtle">
                  <td className={cn(td, "font-mono")}>{i.item_code}</td><td className={td}>{i.description}</td><td className={cn(td, "text-right")}>{i.qty}</td><td className={cn(td, "text-right")}>{i.foc_qty || "--"}</td>
                  <td className={cn(td, "text-right font-mono")}>{rmCell(i.gross_sen)}</td><td className={cn(td, "text-right font-mono")}>{i.discount_sen ? rmCell(i.discount_sen) : "--"}</td><td className={cn(td, "text-right font-mono font-semibold")}>{rmCell(i.net_sen)}</td>
                  <td className={cn(td, "text-right font-mono", left != null && left < 0 && "font-semibold text-rose-800")}>{left ?? "--"}</td>
                </tr>
              );
            })}
          </Table>
        </>
      )}
    </div>
  );
}
