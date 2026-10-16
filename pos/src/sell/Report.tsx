/* Sales report (layout P13, Ctrl+T): Today / Pick date / Full event, this
 * terminal from local data (offline) or all terminals from the ERP
 * (supervisor, online). KPIs, by payment method with refunds and net
 * received, by salesman, FOC, void / return, top items. Print daily report
 * (thermal Z-report), Export PDF (print page), Export Excel. Re-printable
 * any time; there is no close-counter step. Test sales are excluded. */
import { useEffect, useMemo, useState } from "react";
import { aggregateSales, type ReportSale, type ReportTotals } from "@shared/pos-report";
import { posMethodLabel } from "@shared/pos-vocabulary";
import { deviceApi, erpReachable } from "../api";
import { escposBytes } from "../escpos";
import { fmtMyt } from "../loginRules";
import { printBytes, printerStatus } from "../printer";
import { downloadReportXlsx, localReport, rangeDays, reportHtml, zReportLines, type ReportRange } from "../report";
import { mytDate } from "../sale";
import { listSales } from "../salesStore";
import type { BundleCashier, DeviceState, Session } from "../types";
import { Modal } from "./Modal";
import { SupervisorPin } from "./SupervisorPin";

const rm = (sen: number): string => (sen < 0 ? `-${(-sen / 100).toFixed(2)}` : (sen / 100).toFixed(2));

export function ReportPopup({ state, session, onClose, say }: { state: DeviceState; session: Session; onClose: () => void; say: (text: string, bad?: boolean) => void }) {
  const ev = state.bundle.event;
  const [range, setRange] = useState<ReportRange>({ kind: "today" });
  const [scope, setScope] = useState<"terminal" | "all">("terminal");
  const [pinFor, setPinFor] = useState<null | "all">(null);
  const [local, setLocal] = useState<ReportTotals | null>(null);
  const [remote, setRemote] = useState<{ totals: ReportTotals; at: string } | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const days = useMemo(() => rangeDays(range, ev, new Date().toISOString()), [range, ev]);
  const isSupervisor = session.cashier.role === "SUPERVISOR";

  useEffect(() => {
    listSales().then((rows) => setLocal(localReport(rows, days))).catch(() => say("Could not read bills", true));
  }, [days, say]);

  useEffect(() => {
    if (scope !== "all") { setRemote(null); return; }
    let gone = false;
    setRemoteError(null);
    (async () => {
      if (!(await erpReachable())) { if (!gone) setRemoteError("The ERP is not reachable; all-terminals needs a connection. Showing this terminal."); return; }
      try {
        const r = await deviceApi.report<ReportSale>(state.token, days.from, days.to);
        if (!gone) setRemote({ totals: aggregateSales(r.sales), at: new Date().toISOString() });
      } catch (e) {
        if (!gone) setRemoteError(e instanceof Error ? e.message : "Could not load the event report");
      }
    })();
    return () => { gone = true; };
  }, [scope, days, state.token]);

  const totals = scope === "all" && remote ? remote.totals : local;
  const scopeLabel = scope === "all" && remote ? "All terminals" : state.bundle.terminal.code;
  const printedAt = fmtMyt(new Date().toISOString());

  async function printZ() {
    if (!totals) return;
    if (!printerStatus().connected) { say("No printer connected", true); return; }
    setBusy("print");
    try {
      await printBytes(escposBytes(zReportLines(totals, { state, scope: scopeLabel, rangeLabel: days.label, printedAt }), { barcode: null, copies: 1, cut: true }));
      say("Daily report printed");
    } catch (e) {
      say(e instanceof Error ? e.message : "Print failed", true);
    } finally {
      setBusy(null);
    }
  }
  function exportPdf() {
    if (!totals) return;
    const html = reportHtml(totals, { company: state.bundle.company.name, event: ev.name, scope: scopeLabel, rangeLabel: days.label, printedAt });
    const w = window.open("", "_blank");
    if (!w) { say("Allow pop-ups to open the PDF page", true); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }
  async function exportXlsx() {
    if (!totals) return;
    setBusy("xlsx");
    try {
      await downloadReportXlsx(`${ev.name} · ${scopeLabel} · ${days.label}`, totals, `POS_report_${state.bundle.terminal.code}_${days.from}${days.to !== days.from ? `_${days.to}` : ""}.xlsx`);
    } catch {
      say("Could not write the Excel file", true);
    } finally {
      setBusy(null);
    }
  }
  const pickAll = () => { if (!isSupervisor) { setPinFor("all"); return; } setScope("all"); };
  const onPin = (_s: BundleCashier) => { setPinFor(null); setScope("all"); };

  const seg = (on: boolean) => `btn${on ? " primary" : ""}`;
  return (
    <Modal title="Sales report" onClose={onClose} width={720} footer={
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" disabled={!totals || busy !== null} onClick={() => void exportXlsx()}>Export Excel</button>
        <button type="button" className="btn" disabled={!totals} onClick={exportPdf}>Export PDF</button>
        <button type="button" className="btn primary focus-first" disabled={!totals || busy !== null} onClick={() => void printZ()}>Print daily report</button>
      </div>
    }>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" className={seg(range.kind === "today")} onClick={() => setRange({ kind: "today" })}>Today</button>
        <button type="button" className={seg(range.kind === "date")} onClick={() => setRange({ kind: "date", date: range.kind === "date" ? range.date : mytDate(new Date().toISOString()) })}>Pick date</button>
        {range.kind === "date" && <input type="date" value={range.date} min={ev.start_date ?? undefined} max={ev.end_date ?? undefined} onChange={(e) => { if (e.target.value) setRange({ kind: "date", date: e.target.value }); }} aria-label="Report date" />}
        <button type="button" className={seg(range.kind === "event")} onClick={() => setRange({ kind: "event" })}>Full event</button>
        <span style={{ flex: 1 }} />
        <button type="button" className={seg(scope === "terminal")} onClick={() => setScope("terminal")}>{state.bundle.terminal.code}</button>
        <button type="button" className={seg(scope === "all")} onClick={pickAll} title="Every terminal of the event, from the ERP (supervisor)">All terminals</button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {days.label} · {scope === "all" ? (remote ? `all terminals, as synced to the ERP at ${fmtMyt(remote.at)}; bills still pending on devices are not in yet` : remoteError ?? "loading from the ERP…") : `${state.bundle.terminal.code}, from this device`} · test sales excluded
      </div>
      {totals && (
        <div className="report">
          <div className="kpis">
            <div><span>Bills</span><b>{totals.bills}</b></div>
            <div><span>Net sales</span><b>RM {rm(totals.net_sen)}</b></div>
            <div><span>Discount</span><b>RM {rm(totals.discount_sen)}</b></div>
            <div><span>Void</span><b>{totals.void_count} <small>RM {rm(totals.void_sen)}</small></b></div>
            <div><span>Return</span><b>{totals.return_count} <small>RM {rm(totals.return_sen)}</small></b></div>
            <div><span>FOC units</span><b>{totals.foc_units}</b></div>
          </div>
          <div className="cols">
            <div>
              <h4>By payment method</h4>
              <table className="rpt"><thead><tr><th>Method</th><th className="num">Sales</th><th className="num">Refunds</th><th className="num">Net received</th></tr></thead><tbody>
                {totals.by_method.map((m) => <tr key={m.method}><td>{posMethodLabel(m.method)}</td><td className="num">{rm(m.sales_sen)}</td><td className="num">{m.refund_sen ? `-${rm(m.refund_sen)}` : "--"}</td><td className="num">{rm(m.amount_sen)}</td></tr>)}
                <tr className="total"><td>Net received</td><td /><td /><td className="num">{rm(totals.by_method.reduce((n, m) => n + m.amount_sen, 0))}</td></tr>
              </tbody></table>
              <h4>By salesman</h4>
              <table className="rpt"><tbody>{totals.by_salesman.map((s) => <tr key={s.salesman}><td>{s.salesman}</td><td className="num">{s.bills} bills</td><td className="num">{rm(s.net_sen)}</td></tr>)}</tbody></table>
              {scope === "all" && remote && totals.by_terminal.length > 0 && (<>
                <h4>By terminal</h4>
                <table className="rpt"><tbody>{totals.by_terminal.map((x) => <tr key={x.terminal}><td>{x.terminal}</td><td className="num">{x.bills} bills</td><td className="num">{rm(x.net_sen)}</td></tr>)}</tbody></table>
              </>)}
            </div>
            <div>
              <h4>Top items</h4>
              <table className="rpt"><tbody>{totals.top_items.map((i) => <tr key={i.item_code}><td>{i.description}</td><td className="num">{i.qty}</td><td className="num">{rm(i.net_sen)}</td></tr>)}</tbody></table>
              {(totals.voids.length > 0 || totals.returns.length > 0) && (<>
                <h4>Void / Return</h4>
                <table className="rpt"><tbody>
                  {totals.voids.map((v) => <tr key={v.receipt_no}><td><span className="pill outb">VOID</span> {v.receipt_no}</td><td>{v.reason}</td><td className="num">{rm(v.total_sen)}</td></tr>)}
                  {totals.returns.map((r) => <tr key={r.receipt_no}><td><span className="pill auto">RETURN</span> {r.receipt_no}</td><td>{r.ref && `for ${r.ref}`}</td><td className="num">{rm(r.total_sen)}</td></tr>)}
                </tbody></table>
              </>)}
            </div>
          </div>
        </div>
      )}
      {!totals && <div className="muted">Loading…</div>}
      {pinFor && <SupervisorPin why="All terminals needs a supervisor" cashiers={state.bundle.cashiers} onOk={onPin} onClose={() => setPinFor(null)} />}
    </Modal>
  );
}
