import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DataTable, type Column } from "../../components/DataTable";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { errText } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { Tag } from "./HrTablePage";
import { HR, useHourDeductions, useLaborCost, type HourDeduction, type LaborCostResponse } from "./hrApi";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const h2 = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-MY");
const sum = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((a, r) => a + pick(r), 0);
const monthInput = "h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";
type Dept = LaborCostResponse["byDepartment"][number];
type Emp = LaborCostResponse["byEmployee"][number];
const payLabel = (e: Emp) => (e.payMode === "DAILY" ? "Per day" : "Monthly");

function lastDay(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function LaborCostTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const setPeriod = (p: string) => setParams((x) => { const n = new URLSearchParams(x); n.set("period", p); return n; }, { replace: true });
  const to = lastDay(period) < today ? lastDay(period) : today;
  const cost = useLaborCost(`${period}-01`, to < `${period}-01` ? `${period}-01` : to);
  const docks = useHourDeductions(period);
  const [settling, setSettling] = useState(false);
  const [show, setShow] = useState(false);
  const canManage = docks.data?.canManage ?? false;
  const t = cost.data?.totals;
  const money = (sen: number) => (show ? fmtSen(sen) : "RM ••••••");

  async function settle() {
    const ok = await dialog.confirm({
      title: `Settle ${period}?`,
      message: "Every working day so far in the month with logged hours is re-checked: the larger of the punch's short hours and the hours under the standard day is docked. HR's own docks stay; absences (no hours) are not docked, payroll charges the day.",
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

  const deptRows = cost.data?.byDepartment ?? [];
  const empRows = cost.data?.byEmployee ?? [];
  const dockList = docks.data?.deductions ?? [];

  const deptColumns: Column<Dept>[] = [
    { key: "name", label: "Department", getValue: (d) => d.name, render: (d) => <span className="font-semibold text-ink">{d.name}</span> },
    { key: "headcount", label: "People", align: "right", filterType: "number", getValue: (d) => d.headcount, numberValue: (d) => d.headcount, render: (d) => d.headcount, total: (rows) => sum(rows, (d) => d.headcount) },
    { key: "hours", label: "Hours", align: "right", filterType: "number", getValue: (d) => d.hours, numberValue: (d) => d.hours, render: (d) => <span className="font-mono">{h2(d.hours)}</span>, total: (rows) => <span className="font-mono">{h2(sum(rows, (d) => d.hours))}</span> },
    { key: "otHours", label: "OT hours", align: "right", filterType: "number", getValue: (d) => d.otHours, numberValue: (d) => d.otHours, render: (d) => <span className="font-mono">{h2(d.otHours)}</span>, total: (rows) => <span className="font-mono">{h2(sum(rows, (d) => d.otHours))}</span> },
    { key: "otCost", label: "OT cost", align: "right", filterType: "number", getValue: (d) => d.otCostSen / 100, numberValue: (d) => d.otCostSen / 100, render: (d) => <span className="font-mono">{money(d.otCostSen)}</span>, total: (rows) => <span className="font-mono">{money(sum(rows, (d) => d.otCostSen))}</span> },
    { key: "cost", label: "Labor cost", align: "right", filterType: "number", getValue: (d) => d.costSen / 100, numberValue: (d) => d.costSen / 100, render: (d) => <span className="font-money font-semibold text-ink">{money(d.costSen)}</span>, total: (rows) => <span className="font-money font-semibold text-ink">{money(sum(rows, (d) => d.costSen))}</span> },
  ];

  const empColumns: Column<Emp>[] = [
    { key: "empNo", label: "Emp No", getValue: (e) => e.empNo, render: (e) => <span className="font-mono text-[11px] font-semibold text-accent">{e.empNo}</span> },
    { key: "name", label: "Name", getValue: (e) => e.name, render: (e) => e.name },
    { key: "department", label: "Department", getValue: (e) => e.departmentName || "", render: (e) => e.departmentName || <span className="text-ink-muted">—</span> },
    { key: "pay", label: "Pay", getValue: payLabel, render: payLabel },
    { key: "days", label: "Days", align: "right", filterType: "number", getValue: (e) => e.days, numberValue: (e) => e.days, render: (e) => e.days, total: (rows) => sum(rows, (e) => e.days) },
    { key: "hours", label: "Hours", align: "right", filterType: "number", getValue: (e) => e.hours, numberValue: (e) => e.hours, render: (e) => <span className="font-mono">{h2(e.hours)}</span>, total: (rows) => <span className="font-mono">{h2(sum(rows, (e) => e.hours))}</span> },
    { key: "otHours", label: "OT hours", align: "right", filterType: "number", getValue: (e) => e.otHours, numberValue: (e) => e.otHours, render: (e) => <span className="font-mono">{h2(e.otHours)}</span>, total: (rows) => <span className="font-mono">{h2(sum(rows, (e) => e.otHours))}</span> },
    { key: "cost", label: "Labor cost", align: "right", filterType: "number", getValue: (e) => e.costSen / 100, numberValue: (e) => e.costSen / 100, render: (e) => (e.salaryMissing ? <Tag tone="warn">No salary set</Tag> : <span className="font-money">{money(e.costSen)}</span>), total: (rows) => <span className="font-money font-semibold text-ink">{money(sum(rows.filter((e) => !e.salaryMissing), (e) => e.costSen))}</span> },
  ];

  const dockColumns: Column<HourDeduction>[] = [
    { key: "workDate", label: "Date", filterType: "date", newestFirst: true, getValue: (d) => d.workDate, dateValue: (d) => d.workDate, render: (d) => <span className="font-mono">{formatDate(d.workDate)}</span> },
    { key: "empNo", label: "Emp No", getValue: (d) => d.empNo, render: (d) => <span className="font-mono text-[11px] text-accent">{d.empNo}</span> },
    { key: "name", label: "Name", getValue: (d) => d.name, render: (d) => d.name },
    { key: "hours", label: "Hours", align: "right", filterType: "number", getValue: (d) => d.hours, numberValue: (d) => d.hours, render: (d) => <span className="font-mono font-semibold text-err">-{d.hours}h</span>, total: (rows) => <span className="font-mono font-semibold text-err">-{h2(sum(rows, (d) => d.hours))}h</span> },
    { key: "source", label: "Source", getValue: (d) => (d.source === "AUTO" ? "Auto" : "HR"), render: (d) => (d.source === "AUTO" ? <Tag tone="muted">Auto</Tag> : <Tag tone="info">HR</Tag>) },
    { key: "note", label: "Note", getValue: (d) => d.note ?? "", render: (d) => <span className="text-[11px] text-ink-muted">{d.note}</span> },
    { key: "undo", label: "", align: "right", width: "80px", disableSort: true, render: (d) => (canManage ? <button type="button" className={hrSecondaryBtn} onClick={() => void undo(d)}>Undo</button> : null) },
  ];

  return (
    <>
      <HrPageHeader
        title="Labor Cost"
        subtitle={`A month's logged hours priced the way payroll prices them · ${formatDate(`${period}-01`)} – ${formatDate(to)}`}
        actions={
          <>
            <input type="month" value={period} max={today.slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} className={monthInput} />
            <button type="button" onClick={() => setShow((v) => !v)} className={hrSecondaryBtn}>{show ? "Hide amounts" : "Show amounts"}</button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
        {cost.error && <div className="rounded-xl border border-err/40 bg-err-bg p-3 text-[12px] text-err">{cost.error}</div>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat bar="bg-primary" label="Labor cost" value={<span className="font-money">{money(t?.costSen ?? 0)}</span>} sub="regular + OT, from logged hours" />
          <Stat bar="bg-accent" label="OT cost" value={<span className="font-money">{money(t?.otCostSen ?? 0)}</span>} sub={`${h2(t?.otHours ?? 0)} OT hours`} />
          <Stat bar="bg-synced" label="Hours logged" value={h2(t?.hours ?? 0)} sub="this month" />
          <Stat bar="bg-learning" label="People" value={t?.employees ?? 0} sub="with logged hours" />
        </div>

        <Section title="By department">
          <DataTable<Dept>
            tableId="hr-labor-cost-dept"
            documentLabel="Labor cost by department"
            columns={deptColumns}
            rows={deptRows}
            loading={cost.loading && !cost.data}
            error={null}
            emptyLabel="No hours logged this month."
            getRowKey={(d) => String(d.departmentId)}
            clientSearch={{ placeholder: "Search departments" }}
            exportName="labor-cost-by-department"
            exportXlsx
            freezeHeight="off"
          />
        </Section>

        <Section title="By employee">
          <DataTable<Emp>
            tableId="hr-labor-cost-employee"
            documentLabel="Labor cost by employee"
            columns={empColumns}
            rows={empRows}
            loading={cost.loading && !cost.data}
            error={null}
            emptyLabel="No hours logged this month."
            getRowKey={(e) => e.employeeId}
            clientSearch={{ placeholder: "Search employees" }}
            exportName="labor-cost-by-employee"
            exportXlsx
            freezeHeight="off"
          />
        </Section>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <div className="text-[13px] font-bold text-ink">Short-hour docks · {period}</div>
              <div className="text-[11px] text-ink-muted">Late and left early, after same-day OT offsets them. Set from each punch; Settle month re-checks the whole month.{docks.data ? ` ${h2(docks.data.totalHours)} hours docked.` : ""}</div>
            </div>
            {canManage && <button type="button" className={cx(hrPrimaryBtn, "ml-auto")} disabled={settling} onClick={() => void settle()}>{settling ? "Settling…" : "Settle month"}</button>}
          </div>
          <DataTable<HourDeduction>
            tableId="hr-labor-cost-docks"
            documentLabel="Short-hour docks"
            columns={dockColumns}
            rows={dockList}
            loading={docks.loading && !docks.data}
            error={docks.error}
            emptyLabel="Nothing docked this month."
            getRowKey={(d) => d.id}
            clientSearch={{ placeholder: "Search docks" }}
            exportName="short-hour-docks"
            exportXlsx
            freezeHeight="off"
          />
        </section>
      </div>
    </>
  );
}

function Stat({ bar, label, value, sub }: { bar: string; label: string; value: ReactNode; sub: string }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className={cx("h-[3px] w-full", bar)} />
      <div className="px-3.5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
        <div className="mt-1 text-[22px] font-bold leading-none text-ink">{value}</div>
        <div className="mt-1.5 text-[11px] text-ink-muted">{sub}</div>
      </div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-[13px] font-bold text-ink">{title}</div>
      {children}
    </section>
  );
}
