/* HR · Labor Cost (step-2 re-skin). A month's logged hours priced the way
 * payroll prices them, by department and by employee, with the month's
 * short-hour docks (Settle month / Undo). New design; real data and all
 * actions unchanged. (Ported from the old LaborCostTab.) */
import { useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
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
const monthInput = "h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";
type Dept = LaborCostResponse["byDepartment"][number];
type Emp = LaborCostResponse["byEmployee"][number];

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
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {cost.error && <div className="rounded-xl border border-err/40 bg-err-bg p-3 text-[12px] text-err">{cost.error}</div>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat bar="bg-primary" label="Labor cost" value={<span className="font-money">{money(t?.costSen ?? 0)}</span>} sub="regular + OT, from logged hours" />
          <Stat bar="bg-accent" label="OT cost" value={<span className="font-money">{money(t?.otCostSen ?? 0)}</span>} sub={`${h2(t?.otHours ?? 0)} OT hours`} />
          <Stat bar="bg-synced" label="Hours logged" value={h2(t?.hours ?? 0)} sub="this month" />
          <Stat bar="bg-learning" label="People" value={t?.employees ?? 0} sub="with logged hours" />
        </div>

        <Card title="By department">
          <Table head={["Department", "People", "Hours", "OT hours", "OT cost", "Labor cost"]} aligns={["left", "right", "right", "right", "right", "right"]}>
            {deptRows.map((d: Dept) => (
              <tr key={String(d.departmentId)} className="hover:bg-row-hover">
                <Td className="font-semibold text-ink">{d.name}</Td>
                <Td align="right">{d.headcount}</Td>
                <Td align="right" mono>{h2(d.hours)}</Td>
                <Td align="right" mono>{h2(d.otHours)}</Td>
                <Td align="right" mono>{money(d.otCostSen)}</Td>
                <Td align="right"><span className="font-money font-semibold text-ink">{money(d.costSen)}</span></Td>
              </tr>
            ))}
            {!cost.loading && deptRows.length === 0 && <EmptyRow cols={6} label="No hours logged this month." />}
          </Table>
        </Card>

        <Card title="By employee">
          <Table head={["Emp No", "Name", "Department", "Pay", "Days", "Hours", "OT hours", "Labor cost"]} aligns={["left", "left", "left", "left", "right", "right", "right", "right"]}>
            {empRows.map((e: Emp) => (
              <tr key={e.employeeId} className="hover:bg-row-hover">
                <Td mono className="text-[11px] font-semibold text-accent">{e.empNo}</Td>
                <Td>{e.name}</Td>
                <Td>{e.departmentName || <span className="text-ink-muted">—</span>}</Td>
                <Td>{e.payMode === "DAILY" ? "Per day" : "Monthly"}</Td>
                <Td align="right">{e.days}</Td>
                <Td align="right" mono>{h2(e.hours)}</Td>
                <Td align="right" mono>{h2(e.otHours)}</Td>
                <Td align="right">{e.salaryMissing ? <Tag tone="warn">No salary set</Tag> : <span className="font-money">{money(e.costSen)}</span>}</Td>
              </tr>
            ))}
            {!cost.loading && empRows.length === 0 && <EmptyRow cols={8} label="No hours logged this month." />}
          </Table>
        </Card>

        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <div className="text-[13px] font-bold text-ink">Short-hour docks · {period}</div>
              <div className="text-[11px] text-ink-muted">Late and left early, after same-day OT offsets them. Set from each punch; Settle month re-checks the whole month.{docks.data ? ` ${h2(docks.data.totalHours)} hours docked.` : ""}</div>
            </div>
            {canManage && <button type="button" className={cx(hrPrimaryBtn, "ml-auto")} disabled={settling} onClick={() => void settle()}>{settling ? "Settling…" : "Settle month"}</button>}
          </div>
          {docks.data && dockList.length === 0 && <div className="mt-3 text-[12px] text-ink-muted">Nothing docked this month.</div>}
          {dockList.length > 0 && (
            <ul className="mt-3 divide-y divide-border-subtle">
              {dockList.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[12px]">
                  <span className="w-24 font-mono">{formatDate(d.workDate)}</span>
                  <span className="font-mono text-[11px] text-accent">{d.empNo}</span>
                  <span className="text-ink">{d.name}</span>
                  <span className="font-mono font-semibold text-err">-{d.hours}h</span>
                  {d.source === "AUTO" ? <Tag tone="muted">Auto</Tag> : <Tag tone="info">HR</Tag>}
                  <span className="truncate text-[11px] text-ink-muted">{d.note}</span>
                  {canManage && <button type="button" className={cx(hrSecondaryBtn, "ml-auto")} onClick={() => void undo(d)}>Undo</button>}
                </li>
              ))}
            </ul>
          )}
        </div>
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
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="border-b border-border-subtle px-4 py-2 text-[12px] font-bold text-ink">{title}</div>
      <div className="thin-scroll overflow-auto">{children}</div>
    </div>
  );
}
function Table({ head, aligns, children }: { head: string[]; aligns: ("left" | "right" | "center")[]; children: ReactNode }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-[12px]">
      <thead>
        <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
          {head.map((h, i) => <th key={h} className={cx("border-b border-border-subtle bg-surface-2 px-3 py-2", aligns[i] === "right" ? "text-right" : "text-left")}>{h}</th>)}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Td({ children, align, mono, className }: { children: ReactNode; align?: "right"; mono?: boolean; className?: string }) {
  return <td className={cx("border-b border-border-subtle px-3 py-2", align === "right" ? "text-right" : "text-left", mono && "font-mono", className)}>{children}</td>;
}
function EmptyRow({ cols, label }: { cols: number; label: string }) {
  return <tr><td colSpan={cols} className="px-4 py-8 text-center text-[12px] text-ink-muted">{label}</td></tr>;
}
