/* Employees & Attendance > Payroll (HC-0125 phase 4), from Hookka's PayrollTab.
 * v3 design: a clean monthly run — four money cards (gross / deductions / net /
 * run status), a table (basic, allowances, trip pay, overtime, deductions, net,
 * status) with amounts masked behind a Show-amounts eye, and the run actions.
 * A month with no slips shows a projection; Generate stores drafts; Finalise
 * (approve) locks the month; Back to draft reopens; Mark paid closes. Each row
 * opens its full breakdown and prints its payslip. The payroll maths, the slip
 * breakdown and the PDF are unchanged. */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { pcbHasFigure } from "../../vendor/shared/hr-pcb";
import { errText, ghostBtn, primaryBtn } from "../pos-admin/posAdminUi";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Person, Tag, mask, type HrCol, type HrStat } from "./HrTablePage";
import { HR, usePayroll, type Payslip } from "./hrApi";
import { generatePayslipPdf } from "./payslipPdf";

const h2 = (n: number) => String(Math.round(n * 100) / 100);
type PRow = Payslip & { id: number };

const statusTag = (s: Payslip["status"] | "ESTIMATE") =>
  s === "PAID" ? <Tag tone="ok">Paid</Tag> : s === "APPROVED" ? <Tag tone="info">Approved</Tag> : s === "DRAFT" ? <Tag tone="warn">Draft</Tag> : <Tag tone="muted">Estimate</Tag>;

export function PayrollTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const setPeriod = (p: string) => setParams((x) => { const n = new URLSearchParams(x); n.set("period", p); return n; }, { replace: true });
  const q = usePayroll(period);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Payslip | null>(null);
  const d = q.data;
  const slips = useMemo(() => d?.slips ?? [], [d]);
  const rows: PRow[] = useMemo(() => slips.map((s) => ({ ...s, id: s.employeeId })), [slips]);
  const sum = (f: (s: Payslip) => number) => slips.reduce((a, s) => a + f(s), 0);
  const gross = sum((s) => s.grossSen);
  const net = sum((s) => s.netSen);
  const deductions = gross - net;
  const unknownPcb = slips.filter((s) => s.pcbStatus === "UNKNOWN").length;
  const negative = slips.filter((s) => s.netSen < 0).length;
  const review = unknownPcb + negative;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); q.reload(); } catch (e) { toast.error(errText(e, "Could not update the payroll.")); } finally { setBusy(false); }
  };
  const generate = async (regenerate: boolean) => {
    if (regenerate && !(await dialog.confirm({ title: `Regenerate ${period}?`, message: "Every draft slip of the month is worked out again from today's hours, docks, salaries, advances and penalties.", confirmLabel: "Regenerate" }))) return;
    await act(() => api.post(`${HR}/payroll/generate`, { period, regenerate }), regenerate ? "Payroll regenerated" : "Payroll generated");
  };
  const setStatus = async (status: "APPROVED" | "DRAFT" | "PAID") => {
    const text =
      status === "APPROVED"
        ? { title: `Finalise ${period}?`, message: "The month locks: no regenerate, its advances settle and its penalties post to these slips. Staff see the slips in My pay.", confirmLabel: "Finalise payroll" }
        : status === "DRAFT"
          ? { title: `Reopen ${period}?`, message: "The slips go back to draft, advances unsettle and penalties un-post, so the month can be regenerated.", confirmLabel: "Back to draft" }
          : { title: `Mark ${period} paid?`, message: "Records that the salaries have been paid out. It cannot be reopened after this.", confirmLabel: "Mark paid" };
    if (!(await dialog.confirm(text))) return;
    await act(() => api.post(`${HR}/payroll/status`, { period, status }), status === "APPROVED" ? "Payroll finalised" : status === "DRAFT" ? "Payroll reopened" : "Marked paid");
  };

  const m = (sen: number, show: boolean) => mask(fmtSen(sen), show);
  const stats: HrStat[] = [
    { label: "Gross pay", value: (show) => m(gross, show), sub: `${slips.length} employees`, bar: "bg-primary" },
    { label: "Deductions", value: (show) => m(deductions, show), sub: "EPF · SOCSO · EIS · advances · penalties", bar: "bg-err" },
    { label: "Net pay", value: (show) => m(net, show), sub: "take-home", bar: "bg-synced" },
    { label: "Run status", value: () => (d?.projected ? "Estimate" : d?.status && d.status !== "MIXED" ? d.status.charAt(0) + d.status.slice(1).toLowerCase() : "Mixed"), sub: review > 0 ? `${review} items need review` : "all good", bar: "bg-time" },
  ];

  const columns: HrCol<PRow>[] = [
    { key: "emp", label: "Employee", render: (s) => <Person name={s.employeeName} sub={s.empNo} /> },
    { key: "basic", label: "Basic", align: "right", render: (s, show) => (s.payMode === "DAILY" ? (show ? `${fmtSen(s.dayRateSen)}/day` : "RM ••••••") : m(s.fullSalarySen, show)) },
    { key: "allow", label: "Allowances", align: "right", render: (s, show) => (s.allowancesSen ? m(s.allowancesSen, show) : <span className="text-ink-muted">—</span>) },
    { key: "trip", label: "Trip pay", align: "right", render: (s, show) => (s.tripAllowanceSen + s.commissionSen ? m(s.tripAllowanceSen + s.commissionSen, show) : <span className="text-ink-muted">—</span>) },
    { key: "ot", label: "Overtime", align: "right", render: (s, show) => (s.otPaySen ? m(s.otPaySen, show) : <span className="text-ink-muted">—</span>) },
    { key: "ded", label: "Deductions", align: "right", render: (s, show) => { const dd = s.grossSen - s.netSen; return dd > 0 ? <span className="text-err">{show ? `-${fmtSen(dd)}` : "RM ••••••"}</span> : <span className="text-ink-muted">—</span>; } },
    { key: "net", label: "Net pay", align: "right", render: (s, show) => <span className={"font-semibold " + (s.netSen < 0 ? "text-err" : "text-ink")}>{m(s.netSen, show)}</span> },
    { key: "status", label: "Status", align: "center", render: (s) => statusTag(d?.projected ? "ESTIMATE" : s.status) },
  ];

  const actions = (
    <span className="flex flex-wrap gap-2">
      {slips.length > 0 && <button type="button" className={hrSecondaryBtn} onClick={() => void generatePayslipPdf(slips, { action: "preview" })}><Printer size={11} /> Payslips</button>}
      {d?.canManage && d.projected && <button type="button" className={hrPrimaryBtn} disabled={busy} onClick={() => void generate(false)}>Generate</button>}
      {d?.canManage && d.stored && !d.locked && <button type="button" className={hrSecondaryBtn} disabled={busy} onClick={() => void generate(true)}>Regenerate</button>}
      {d?.canApprove && d.stored && d.status === "DRAFT" && <button type="button" className={hrPrimaryBtn} disabled={busy} onClick={() => void setStatus("APPROVED")}>Finalise payroll</button>}
      {d?.canApprove && d.status === "APPROVED" && <button type="button" className={hrSecondaryBtn} disabled={busy} onClick={() => void setStatus("DRAFT")}>Back to draft</button>}
      {d?.canApprove && d.status === "APPROVED" && <button type="button" className={hrPrimaryBtn} disabled={busy} onClick={() => void setStatus("PAID")}>Mark paid</button>}
    </span>
  );

  return (
    <>
      <HrTablePage<PRow>
        title="Payroll"
        subtitle={d?.projected ? `${period} · estimate from the hours so far — nothing is stored until you Generate` : `${period} payroll run`}
        actions={actions}
        stats={stats}
        rows={rows}
        columns={columns}
        searchOf={(s) => `${s.employeeName} ${s.empNo} ${s.departmentName ?? ""}`}
        searchPlaceholder="Search employee"
        onRowClick={(s) => setOpen(s)}
        loading={q.loading}
        error={q.error}
        emptyLabel="Nobody is on this month's payroll."
        moneyToggle
        toolbarExtra={<input type="month" value={period} max={today.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none" aria-label="Month" />}
        footer={(show) => <>Net payable <span className="font-money font-semibold text-ink">{m(net, show)}</span>{review > 0 ? ` · ${review} need review` : ""}</>}
      />
      {open && <SlipDrawer slip={open} projected={!!d?.projected} onClose={() => setOpen(null)} />}
    </>
  );
}

function SlipDrawer({ slip: s, projected, onClose }: { slip: Payslip; projected: boolean; onClose: () => void }) {
  const line = (label: string, value: string, tone?: "neg" | "bold") => (
    <div className={`flex justify-between py-0.5 text-[12px] ${tone === "bold" ? "font-semibold" : ""}`}>
      <span className="text-ink-secondary">{label}</span>
      <span className={`font-mono ${tone === "neg" ? "text-err" : ""}`}>{value}</span>
    </div>
  );
  return (
    <ResizableDrawer
      onClose={onClose}
      title={<span><span className="font-mono">{s.empNo}</span> {s.employeeName}</span>}
      subtitle={`${s.period} · ${projected ? "estimate" : s.status.toLowerCase()} · ${s.payMode === "DAILY" ? `per day ${fmtSen(s.dayRateSen)}` : `monthly ${fmtSen(s.fullSalarySen)}`}`}
      storageKey="hr-payslip-drawer"
      defaultWidth={480}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
          <button type="button" className={primaryBtn} onClick={() => void generatePayslipPdf([s], { action: "preview" })}><Printer size={11} /> Payslip</button>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        <section>
          <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Earnings</h3>
          {s.payMode === "MONTHLY" ? line("Basic salary", fmtSen(s.fullSalarySen)) : line(`${s.daysWorked} days x ${fmtSen(s.dayRateSen)}`, fmtSen(s.basicEarnedSen + s.shortHourDeductionSen))}
          {s.absenceDeductionSen > 0 && line(`Absence ${s.absentDays} day(s) x ${fmtSen(s.dayRateSen)}`, `-${fmtSen(s.absenceDeductionSen)}`, "neg")}
          {s.shortHourDeductionSen > 0 && line(`Late / short ${h2(s.shortHours)} h x ${fmtSen(s.hourRateSen)}`, `-${fmtSen(s.shortHourDeductionSen)}`, "neg")}
          {s.otWeekdayPaySen > 0 && line(`OT weekday ${h2(s.otWeekdayHours)} h`, fmtSen(s.otWeekdayPaySen))}
          {s.otSundayPaySen > 0 && line(`OT Sunday ${h2(s.otSundayHours)} h`, fmtSen(s.otSundayPaySen))}
          {s.otHolidayPaySen > 0 && line(`OT public holiday ${h2(s.otHolidayHours)} h`, fmtSen(s.otHolidayPaySen))}
          {s.detail.trip?.commission.lines.map((l) => line(`Commission ${fmtSen(l.baseSen)} x ${(l.rateBps / 100).toFixed(2)}%`, fmtSen(l.amountSen)))}
          {s.detail.trip?.lines.map((l) => line(`${l.label} x ${l.count}`, fmtSen(l.amountSen)))}
          {(s.detail.allowances ?? []).filter((a) => a.kind !== "BACKPAY").map((a, i) => (
            <div key={`al-${i}`}>{line(a.label, fmtSen(a.amountSen))}</div>
          ))}
          {line("Gross", fmtSen(s.grossSen), "bold")}
        </section>
        <section>
          <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Deductions</h3>
          {line("EPF", fmtSen(s.epfEmployeeSen))}
          {line("SOCSO", fmtSen(s.socsoEmployeeSen))}
          {line("EIS", fmtSen(s.eisEmployeeSen))}
          {line("PCB", s.pcbStatus === "DISABLED" ? "not registered" : pcbHasFigure(s.pcbStatus) ? fmtSen(s.pcbSen) : "not computed")}
          {s.advanceSen > 0 && line(`Advance (${s.detail.advanceDates.map(formatDate).join(", ")})`, fmtSen(s.advanceSen))}
          {s.backpaySen > 0 && line("Backpay (company advance)", fmtSen(s.backpaySen))}
          {s.penaltySen > 0 && line("Penalty", fmtSen(s.penaltySen))}
          {line("Net pay", fmtSen(s.netSen), "bold")}
        </section>
        <section className="text-[11px] text-ink-muted">
          <div>Employer: EPF {fmtSen(s.epfEmployerSen)}, SOCSO {fmtSen(s.socsoEmployerSen)}, EIS {fmtSen(s.eisEmployerSen)}</div>
          <div>Day rate {fmtSen(s.dayRateSen)}, hour rate {fmtSen(s.hourRateSen)}</div>
          {s.detail.absentDates.length > 0 && <div>Absent: {s.detail.absentDates.map(formatDate).join(", ")}</div>}
          {(s.detail.paidLeaveDates?.length ?? 0) > 0 && <div>Paid leave: {s.detail.paidLeaveDates?.map(formatDate).join(", ")}</div>}
          {s.detail.trip && s.detail.trip.commission.cutBps > 0 && (
            <div>Commission rate cut {(s.detail.trip.commission.cutBps / 100).toFixed(2)}% for {s.detail.trip.commission.missedDays} missed day(s)</div>
          )}
          {s.detail.otDays.length > 0 && <div>OT: {s.detail.otDays.map((o) => `${formatDate(o.date)} ${o.hours}h${o.kind === "WEEKDAY" ? "" : o.kind === "SUNDAY" ? " Sun" : " PH"}`).join(", ")}</div>}
          {!pcbHasFigure(s.pcbStatus) && s.pcbStatus !== "DISABLED" && <div className="text-amber-800 dark:text-amber-300">{s.detail.pcbNote}</div>}
          <div>Paid by {s.paymentMethod === "CASH" ? "cash" : `${s.bankName ?? "bank"} ${s.bankAccount ?? ""}`}</div>
        </section>
      </div>
    </ResizableDrawer>
  );
}
