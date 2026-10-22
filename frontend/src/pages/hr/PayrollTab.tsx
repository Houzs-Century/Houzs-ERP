/* Employees & Attendance > Payroll (HC-0125 phase 4), from Hookka's
 * PayrollTab. A month with no slips shows a projection; Generate stores
 * them as drafts; Approve locks the month (advances settle, penalties post);
 * Back to draft reopens it; Mark paid closes it. Hookka had no button for the
 * last two. Each row opens its breakdown and prints its payslip. */
import { useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { pcbHasFigure } from "../../vendor/shared/hr-pcb";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, usePayroll, type Payslip } from "./hrApi";
import { generatePayslipPdf } from "./payslipPdf";

const h2 = (n: number) => String(Math.round(n * 100) / 100);
const statusPill = (s: Payslip["status"] | "ESTIMATE") =>
  s === "PAID" ? <Pill tone="ok">Paid</Pill> : s === "APPROVED" ? <Pill tone="info">Approved</Pill> : s === "DRAFT" ? <Pill tone="warn">Draft</Pill> : <Pill tone="muted">Estimate</Pill>;
const pcbCell = (s: Payslip) => (s.pcbStatus === "DISABLED" ? <span className="text-ink-muted">--</span> : pcbHasFigure(s.pcbStatus) ? fmtSen(s.pcbSen) : <span title="Tax profile incomplete" className="text-amber-800">not computed</span>);

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{value}</div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

export function PayrollTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const setPeriod = (p: string) =>
    setParams(
      (x) => {
        const n = new URLSearchParams(x);
        n.set("period", p);
        return n;
      },
      { replace: true },
    );
  const q = usePayroll(period);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Payslip | null>(null);
  const d = q.data;
  const slips = useMemo(() => d?.slips ?? [], [d]);
  const sum = (f: (s: Payslip) => number) => slips.reduce((a, s) => a + f(s), 0);
  const employer = sum((s) => s.epfEmployerSen + s.socsoEmployerSen + s.eisEmployerSen);
  const unknownPcb = slips.filter((s) => s.pcbStatus === "UNKNOWN").length;
  const negative = slips.filter((s) => s.netSen < 0).length;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not update the payroll."));
    } finally {
      setBusy(false);
    }
  };
  const generate = async (regenerate: boolean) => {
    if (regenerate && !(await dialog.confirm({ title: `Regenerate ${period}?`, message: "Every draft slip of the month is worked out again from today's hours, docks, salaries, advances and penalties.", confirmLabel: "Regenerate" }))) return;
    await act(() => api.post(`${HR}/payroll/generate`, { period, regenerate }), regenerate ? "Payroll regenerated" : "Payroll generated");
  };
  const setStatus = async (status: "APPROVED" | "DRAFT" | "PAID") => {
    const text =
      status === "APPROVED"
        ? { title: `Approve ${period}?`, message: "The month locks: no regenerate, its advances settle and its penalties post to these slips. Staff see the slips in My pay.", confirmLabel: "Approve" }
        : status === "DRAFT"
          ? { title: `Reopen ${period}?`, message: "The slips go back to draft, advances unsettle and penalties un-post, so the month can be regenerated.", confirmLabel: "Back to draft" }
          : { title: `Mark ${period} paid?`, message: "Records that the salaries have been paid out. It cannot be reopened after this.", confirmLabel: "Mark paid" };
    if (!(await dialog.confirm(text))) return;
    await act(() => api.post(`${HR}/payroll/status`, { period, status }), status === "APPROVED" ? "Payroll approved" : status === "DRAFT" ? "Payroll reopened" : "Marked paid");
  };

  const columns: Column<Payslip>[] = [
    { key: "empNo", label: "Emp No", getValue: (s) => s.empNo, render: (s) => <span className="font-mono text-[11px] font-semibold text-accent">{s.empNo}</span> },
    { key: "name", label: "Name", getValue: (s) => s.employeeName, render: (s) => s.employeeName },
    { key: "department", label: "Department", defaultHidden: true, getValue: (s) => s.departmentName ?? "", render: (s) => s.departmentName ?? "" },
    { key: "basic", label: "Basic", align: "right", getValue: (s) => s.fullSalarySen, render: (s) => (s.payMode === "DAILY" ? <span className="text-[10.5px]">{fmtSen(s.dayRateSen)}/day</span> : fmtSen(s.fullSalarySen)) },
    { key: "days", label: "Days", align: "right", getValue: (s) => s.daysWorked, render: (s) => s.daysWorked },
    {
      key: "absence",
      label: "Absence",
      align: "right",
      getValue: (s) => s.absenceDeductionSen,
      render: (s) => (s.absenceDeductionSen > 0 ? <span className="text-err">-{fmtSen(s.absenceDeductionSen)} ({s.absentDays}d)</span> : null),
    },
    {
      key: "short",
      label: "Late / Short",
      align: "right",
      getValue: (s) => s.shortHourDeductionSen,
      render: (s) => (s.shortHourDeductionSen > 0 ? <span className="text-err">-{fmtSen(s.shortHourDeductionSen)} ({h2(s.shortHours)}h)</span> : null),
    },
    {
      key: "otHours",
      label: "OT Wk / Sun / PH",
      align: "right",
      getValue: (s) => s.otWeekdayHours + s.otSundayHours + s.otHolidayHours,
      render: (s) => <span className="font-mono text-[11px]">{h2(s.otWeekdayHours)} / {h2(s.otSundayHours)} / {h2(s.otHolidayHours)}</span>,
    },
    { key: "ot", label: "OT Pay", align: "right", getValue: (s) => s.otPaySen, render: (s) => fmtSen(s.otPaySen) },
    { key: "gross", label: "Gross", align: "right", getValue: (s) => s.grossSen, render: (s) => <span className="font-semibold">{fmtSen(s.grossSen)}</span>, total: (r) => fmtSen(r.reduce((a, s) => a + s.grossSen, 0)) },
    { key: "epf", label: "EPF EE", align: "right", getValue: (s) => s.epfEmployeeSen, render: (s) => fmtSen(s.epfEmployeeSen) },
    { key: "epfEr", label: "EPF ER", align: "right", defaultHidden: true, getValue: (s) => s.epfEmployerSen, render: (s) => fmtSen(s.epfEmployerSen) },
    { key: "socso", label: "SOCSO", align: "right", getValue: (s) => s.socsoEmployeeSen, render: (s) => fmtSen(s.socsoEmployeeSen) },
    { key: "eis", label: "EIS", align: "right", getValue: (s) => s.eisEmployeeSen, render: (s) => fmtSen(s.eisEmployeeSen) },
    { key: "pcb", label: "PCB", align: "right", getValue: (s) => s.pcbSen, render: pcbCell },
    { key: "advance", label: "Advance", align: "right", getValue: (s) => s.advanceSen, render: (s) => (s.advanceSen ? `-${fmtSen(s.advanceSen)}` : null) },
    { key: "penalty", label: "Penalty", align: "right", getValue: (s) => s.penaltySen, render: (s) => (s.penaltySen ? `-${fmtSen(s.penaltySen)}` : null) },
    {
      key: "net",
      label: "Net",
      align: "right",
      getValue: (s) => s.netSen,
      render: (s) => <span className={`font-mono font-semibold ${s.netSen < 0 ? "text-err" : ""}`}>{fmtSen(s.netSen)}</span>,
      total: (r) => fmtSen(r.reduce((a, s) => a + s.netSen, 0)),
    },
    { key: "payBy", label: "Pay By", getValue: (s) => s.paymentMethod, render: (s) => (s.paymentMethod === "CASH" ? "Cash" : s.bankName ?? "Transfer") },
    { key: "status", label: "Status", getValue: (s) => (d?.projected ? "ESTIMATE" : s.status), render: (s) => statusPill(d?.projected ? "ESTIMATE" : s.status) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month" className="w-40">
          <input type="month" className={inputCls} value={period} max={today.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        </Field>
        {d && <span className="pb-2">{d.projected ? statusPill("ESTIMATE") : d.status && d.status !== "MIXED" ? statusPill(d.status) : <Pill tone="warn">Mixed</Pill>}</span>}
        <span className="ml-auto flex flex-wrap gap-2 pb-1">
          {d?.canManage && d.projected && (
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void generate(false)}>
              Generate
            </button>
          )}
          {d?.canManage && d.stored && !d.locked && (
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => void generate(true)}>
              Regenerate
            </button>
          )}
          {d?.canApprove && d.stored && d.status === "DRAFT" && (
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void setStatus("APPROVED")}>
              Approve
            </button>
          )}
          {d?.canApprove && d.status === "APPROVED" && (
            <>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => void setStatus("DRAFT")}>
                Back to draft
              </button>
              <button type="button" className={primaryBtn} disabled={busy} onClick={() => void setStatus("PAID")}>
                Mark paid
              </button>
            </>
          )}
          {slips.length > 0 && (
            <button type="button" className={ghostBtn} onClick={() => void generatePayslipPdf(slips, { action: "preview" })}>
              <Printer size={11} /> All payslips
            </button>
          )}
        </span>
      </div>

      {d?.projected && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
          An estimate from the hours so far: nothing is stored until Generate.{d.monthFinished ? "" : " Absences are counted only after the grace in Pay Rules, so the month will still move."}
        </div>
      )}
      {(unknownPcb > 0 || negative > 0) && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-[11.5px] text-ink-secondary">
          {unknownPcb > 0 && <div>PCB not computed for {unknownPcb} employee(s): their tax residency, marital category or child relief is missing in Employee Master. Their net pay withholds no tax.</div>}
          {negative > 0 && <div className="text-err">{negative} slip(s) have a negative net: advances or penalties exceed the pay.</div>}
        </div>
      )}
      {slips.length > 0 && (
        <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
          <Kpi label="Total cost" value={fmtSen(sum((s) => s.grossSen) + employer)} sub="gross + employer EPF / SOCSO / EIS" />
          <Kpi label="Gross" value={fmtSen(sum((s) => s.grossSen))} />
          <Kpi label="Net" value={fmtSen(sum((s) => s.netSen))} />
          <Kpi label="Statutory" value={fmtSen(sum((s) => s.statutoryEmployeeSen) + employer)} sub={unknownPcb ? "+ PCB not computed" : "employee + employer"} />
        </div>
      )}
      <DataTable<Payslip>
        tableId="hr-payroll"
        columns={columns}
        rows={d ? slips : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="Nobody is on this month's payroll."
        getRowKey={(s) => s.employeeId}
        onRowClick={(s) => setOpen(s)}
        exportName={`payroll-${period}`}
      />
      {open && <SlipDrawer slip={open} projected={!!d?.projected} onClose={() => setOpen(null)} />}
    </div>
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
      title={
        <span>
          <span className="font-mono">{s.empNo}</span> {s.employeeName}
        </span>
      }
      subtitle={`${s.period} · ${projected ? "estimate" : s.status.toLowerCase()} · ${s.payMode === "DAILY" ? `per day ${fmtSen(s.dayRateSen)}` : `monthly ${fmtSen(s.fullSalarySen)}`}`}
      storageKey="hr-payslip-drawer"
      defaultWidth={480}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>
            Close
          </button>
          <button type="button" className={primaryBtn} onClick={() => void generatePayslipPdf([s], { action: "preview" })}>
            <Printer size={11} /> Payslip
          </button>
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
          {line("Gross", fmtSen(s.grossSen), "bold")}
        </section>
        <section>
          <h3 className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Deductions</h3>
          {line("EPF", fmtSen(s.epfEmployeeSen))}
          {line("SOCSO", fmtSen(s.socsoEmployeeSen))}
          {line("EIS", fmtSen(s.eisEmployeeSen))}
          {line("PCB", s.pcbStatus === "DISABLED" ? "not registered" : pcbHasFigure(s.pcbStatus) ? fmtSen(s.pcbSen) : "not computed")}
          {s.advanceSen > 0 && line(`Advance (${s.detail.advanceDates.map(formatDate).join(", ")})`, fmtSen(s.advanceSen))}
          {s.penaltySen > 0 && line("Penalty", fmtSen(s.penaltySen))}
          {line("Net pay", fmtSen(s.netSen), "bold")}
        </section>
        <section className="text-[11px] text-ink-muted">
          <div>Employer: EPF {fmtSen(s.epfEmployerSen)}, SOCSO {fmtSen(s.socsoEmployerSen)}, EIS {fmtSen(s.eisEmployerSen)}</div>
          <div>Day rate {fmtSen(s.dayRateSen)}, hour rate {fmtSen(s.hourRateSen)}</div>
          {s.detail.absentDates.length > 0 && <div>Absent: {s.detail.absentDates.map(formatDate).join(", ")}</div>}
          {s.detail.otDays.length > 0 && <div>OT: {s.detail.otDays.map((o) => `${formatDate(o.date)} ${o.hours}h${o.kind === "WEEKDAY" ? "" : o.kind === "SUNDAY" ? " Sun" : " PH"}`).join(", ")}</div>}
          {!pcbHasFigure(s.pcbStatus) && s.pcbStatus !== "DISABLED" && <div className="text-amber-800">{s.detail.pcbNote}</div>}
          <div>Paid by {s.paymentMethod === "CASH" ? "cash" : `${s.bankName ?? "bank"} ${s.bankAccount ?? ""}`}</div>
        </section>
      </div>
    </ResizableDrawer>
  );
}
