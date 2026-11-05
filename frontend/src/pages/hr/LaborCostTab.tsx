/* Employees & Attendance > Labor Cost (HC-0125 phase 3), from Hookka's
 * LaborCostTab and Department Labor tab together. A month's logged hours
 * priced the way payroll prices them: regular hours at salary / the month's
 * working days / standard hours, OT by day type. By department (Hookka's
 * Department Labor) and by employee. Hookka set this against production
 * revenue by SOFA / BEDFRAME line; Century has none, so it is cost only.
 * The short-hour docks of the month sit below, with Settle month and Undo. */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, useHourDeductions, useLaborCost, type HourDeduction, type LaborCostResponse } from "./hrApi";

const h2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-MY");
type Dept = LaborCostResponse["byDepartment"][number];
type Emp = LaborCostResponse["byEmployee"][number];

function lastDay(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{value}</div>
      {sub && <div className="text-[10.5px] text-ink-muted">{sub}</div>}
    </div>
  );
}

const DEPT_COLUMNS: Column<Dept>[] = [
  { key: "name", label: "Department", getValue: (d) => d.name, render: (d) => <span className="font-semibold">{d.name}</span> },
  { key: "headcount", label: "People", align: "right", getValue: (d) => d.headcount, render: (d) => d.headcount },
  { key: "hours", label: "Hours", align: "right", getValue: (d) => d.hours, render: (d) => <span className="font-mono">{h2(d.hours)}</span> },
  { key: "ot", label: "OT Hours", align: "right", getValue: (d) => d.otHours, render: (d) => <span className="font-mono">{h2(d.otHours)}</span> },
  { key: "otCost", label: "OT Cost", align: "right", getValue: (d) => d.otCostSen, render: (d) => <span className="font-mono">{fmtSen(d.otCostSen)}</span> },
  { key: "cost", label: "Labor Cost", align: "right", getValue: (d) => d.costSen, render: (d) => <span className="font-mono font-semibold">{fmtSen(d.costSen)}</span>, total: (rows) => fmtSen(rows.reduce((s, r) => s + r.costSen, 0)) },
];

const EMP_COLUMNS: Column<Emp>[] = [
  { key: "empNo", label: "Emp No", getValue: (e) => e.empNo, render: (e) => <span className="font-mono text-[11px] font-semibold text-accent">{e.empNo}</span> },
  { key: "name", label: "Name", getValue: (e) => e.name, render: (e) => e.name },
  { key: "department", label: "Department", getValue: (e) => e.departmentName, render: (e) => e.departmentName || <span className="text-ink-muted">--</span> },
  { key: "pay", label: "Pay", getValue: (e) => e.payMode, render: (e) => (e.payMode === "DAILY" ? "Per day" : "Monthly") },
  { key: "days", label: "Days", align: "right", getValue: (e) => e.days, render: (e) => e.days },
  { key: "hours", label: "Hours", align: "right", getValue: (e) => e.hours, render: (e) => <span className="font-mono">{h2(e.hours)}</span> },
  { key: "ot", label: "OT Hours", align: "right", getValue: (e) => e.otHours, render: (e) => <span className="font-mono">{h2(e.otHours)}</span> },
  {
    key: "cost",
    label: "Labor Cost",
    align: "right",
    getValue: (e) => e.costSen,
    render: (e) => (e.salaryMissing ? <Pill tone="warn">No salary set</Pill> : <span className="font-mono">{fmtSen(e.costSen)}</span>),
  },
];

export function LaborCostTab() {
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
  const to = lastDay(period) < today ? lastDay(period) : today;
  const cost = useLaborCost(`${period}-01`, to < `${period}-01` ? `${period}-01` : to);
  const docks = useHourDeductions(period);
  const [settling, setSettling] = useState(false);
  const canManage = docks.data?.canManage ?? false;
  const t = cost.data?.totals;

  async function settle() {
    const ok = await dialog.confirm({
      title: `Settle ${period}?`,
      message:
        "Every working day so far in the month with logged hours is re-checked: the larger of the punch's short hours and the hours under the standard day is docked. HR's own docks stay; absences (no hours) are not docked, payroll charges the day.",
      confirmLabel: "Settle month",
    });
    if (!ok) return;
    setSettling(true);
    try {
      const r = await api.post<{ docked: number; cleared: number; manualKept: number; days: number }>(`${HR}/hour-deductions/settle`, { period });
      toast.success(`${period} settled: ${r.docked} days docked, ${r.days} days checked`);
      docks.reload();
    } catch (e) {
      toast.error(errText(e, "Could not settle the month."));
    } finally {
      setSettling(false);
    }
  }

  async function undo(d: HourDeduction) {
    const ok = await dialog.confirm({ title: `Undo ${d.empNo}'s ${d.hours}h dock on ${formatDate(d.workDate)}?`, message: "It is not docked. Settle month or a punch change may set an AUTO dock again.", confirmLabel: "Undo", tone: "danger" });
    if (!ok) return;
    try {
      await api.del(`${HR}/hour-deductions/${d.id}`);
      toast.success("Dock removed");
      docks.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the dock."));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month" className="w-40">
          <input type="month" className={inputCls} value={period} max={today.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
        </Field>
        <span className="pb-2 text-[11px] text-ink-muted">
          {formatDate(`${period}-01`)} to {formatDate(to)}
        </span>
      </div>
      {cost.error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">{cost.error}</div>}
      {t && (
        <div className="grid grid-cols-5 gap-2 max-lg:grid-cols-3 max-sm:grid-cols-2">
          <Kpi label="Labor cost" value={fmtSen(t.costSen)} sub="regular + OT, from logged hours" />
          <Kpi label="OT cost" value={fmtSen(t.otCostSen)} />
          <Kpi label="Hours" value={h2(t.hours)} />
          <Kpi label="OT hours" value={h2(t.otHours)} />
          <Kpi label="People" value={String(t.employees)} />
        </div>
      )}
      <div>
        <div className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">By department</div>
        <DataTable<Dept> tableId="hr-labor-by-dept" columns={DEPT_COLUMNS} rows={cost.data ? cost.data.byDepartment : null} loading={cost.loading} emptyLabel="No hours logged this month." getRowKey={(d) => String(d.departmentId)} />
      </div>
      <div>
        <div className="mb-1 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">By employee</div>
        <DataTable<Emp>
          tableId="hr-labor-by-employee"
          columns={EMP_COLUMNS}
          rows={cost.data ? cost.data.byEmployee : null}
          loading={cost.loading}
          emptyLabel="No hours logged this month."
          getRowKey={(e) => e.employeeId}
          exportName={`labor-cost-${period}`}
        />
      </div>

      <div className="rounded-md border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">Short-hour docks · {period}</div>
            <div className="text-[11px] text-ink-secondary">
              Late and left early, after same-day OT offsets them. Set from each punch; Settle month re-checks the whole month.{docks.data ? ` ${h2(docks.data.totalHours)} hours docked.` : ""}
            </div>
          </div>
          {canManage && (
            <button type="button" className={`${primaryBtn} ml-auto`} disabled={settling} onClick={() => void settle()}>
              {settling ? "Settling..." : "Settle month"}
            </button>
          )}
        </div>
        {docks.data && docks.data.deductions.length === 0 && <div className="mt-2 text-[11px] text-ink-muted">Nothing docked this month.</div>}
        {docks.data && docks.data.deductions.length > 0 && (
          <ul className="mt-2 divide-y divide-border-subtle">
            {docks.data.deductions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[11.5px]">
                <span className="w-24 font-mono">{formatDate(d.workDate)}</span>
                <span className="font-mono text-[11px] text-accent">{d.empNo}</span>
                <span>{d.name}</span>
                <span className="font-mono font-semibold">-{d.hours}h</span>
                {d.source === "AUTO" ? <Pill tone="muted">Auto</Pill> : <Pill tone="info">HR</Pill>}
                <span className="truncate text-[10.5px] text-ink-muted">{d.note}</span>
                {canManage && (
                  <button type="button" className={`${ghostBtn} ml-auto`} onClick={() => void undo(d)}>
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
