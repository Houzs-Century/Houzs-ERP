/* HR · Advances (step-2 re-skin). Cash given ahead of payday, taken back in
 * full from the slip of the month it was given. New design over HrTablePage,
 * real /api/hr/advances data, record via a modal, remove an unsettled one.
 * (Ported from the old AdvancesTab.) */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { errText } from "../pos-admin/posAdminUi";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Tag, mask, type HrCol } from "./HrTablePage";
import { HR, rmFromSen, senFromRm, useAdvances, useEmployees, type Advance } from "./hrApi";

const monthInput = "h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";

export function AdvancesPage() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const q = useAdvances(period);
  const [recording, setRecording] = useState(false);
  const canManage = q.data?.canManage ?? false;

  const setPeriod = (next: string) =>
    next && setParams((x) => { const n = new URLSearchParams(x); n.set("period", next); return n; }, { replace: true });

  const rows = useMemo(() => q.data?.advances ?? [], [q.data]);
  const toDeduct = rows.reduce((s, a) => s + a.thisMonthSen, 0);
  const owing = rows.reduce((s, a) => s + a.remainingSen, 0);

  async function remove(a: Advance) {
    if (!(await dialog.confirm({ title: `Remove ${a.empNo}'s ${fmtSen(a.amountSen)} advance?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await api.del(`${HR}/advances/${a.id}`);
      toast.success("Advance removed");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the advance."));
    }
  }

  const columns: HrCol<Advance>[] = [
    { key: "date", label: "Date", filterType: "date", getValue: (a) => a.date, render: (a) => <span className="font-mono">{formatDate(a.date)}</span> },
    { key: "emp", label: "Employee", getValue: (a) => `${a.name} ${a.empNo}`, render: (a) => <span><span className="font-mono text-[11px] font-semibold text-accent">{a.empNo}</span> <span className="text-ink">{a.name}</span></span> },
    { key: "amount", label: "Amount", align: "right", filterType: "number", getValue: (a) => a.amountSen / 100, render: (a, show) => <span className="font-money text-ink">{mask(fmtSen(a.amountSen), show)}</span> },
    { key: "schedule", label: "Repayment", align: "right", getValue: (a) => (a.installmentSen == null ? 0 : a.installmentSen / 100), render: (a, show) => (a.installmentSen == null ? <span className="text-ink-muted">Lump sum</span> : <span className="font-money text-ink-secondary">{mask(fmtSen(a.installmentSen), show)}<span className="text-ink-muted">/mo</span></span>) },
    { key: "thismonth", label: "This month", align: "right", filterType: "number", getValue: (a) => a.thisMonthSen / 100, render: (a, show) => <span className="font-money text-ink">{mask(fmtSen(a.thisMonthSen), show)}</span> },
    { key: "remaining", label: "Remaining", align: "right", filterType: "number", getValue: (a) => a.remainingSen / 100, render: (a, show) => (a.remainingSen > 0 ? <span className="font-money text-ink-secondary">{mask(fmtSen(a.remainingSen), show)}</span> : <span className="text-ink-muted">—</span>) },
    { key: "note", label: "Note", getValue: (a) => a.note ?? "", render: (a) => <span className="text-ink-secondary">{a.note || "—"}</span> },
    { key: "status", label: "Status", getValue: (a) => (a.remainingSen > 0 ? "Repaying" : a.status === "SETTLED" ? "Settled" : a.thisMonthSen > 0 ? "To deduct" : "Settled"), render: (a) => (a.remainingSen > 0 ? <Tag tone="info">Repaying</Tag> : a.status === "SETTLED" ? <Tag tone="ok">Settled</Tag> : a.thisMonthSen > 0 ? <Tag tone="warn">To deduct</Tag> : <Tag tone="ok">Settled</Tag>) },
    { key: "actions", label: "", align: "right", disableSort: true, render: (a) => (canManage && a.status === "UNSETTLED" ? <button type="button" onClick={() => void remove(a)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-err/40 hover:text-err">Remove</button> : null) },
  ];

  return (
    <>
      <HrTablePage<Advance>
        title="Advances"
        subtitle="Cash given ahead of payday, recovered in full"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setRecording(true)}>+ Record advance</button> : undefined}
        stats={[
          { label: "This month", value: (s) => <span className="font-money">{mask(fmtSen(toDeduct), s)}</span>, sub: "to deduct from pay", bar: "bg-time" },
          { label: "Outstanding", value: (s) => <span className="font-money">{mask(fmtSen(owing), s)}</span>, sub: "owed after this month", bar: "bg-primary" },
          { label: "Advances", value: () => rows.length, sub: "on this month's slip", bar: "bg-synced" },
          { label: "Total given", value: (s) => <span className="font-money">{mask(fmtSen(q.data?.totalSen ?? 0), s)}</span>, sub: "full value shown", bar: "bg-accent" },
        ]}
        moneyToggle
        toolbarExtra={<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className={monthInput} />}
        rows={rows}
        columns={columns}
        searchOf={(a) => `${a.name} ${a.empNo} ${a.note ?? ""}`}
        searchPlaceholder="Search employee or note"
        loading={q.loading && !q.data}
        error={q.error}
        emptyLabel="No advances given this month."
        footer={(s) => <>to deduct this month <span className="font-money font-semibold text-ink">{mask(fmtSen(toDeduct), s)}</span></>}
      />
      {recording && <RecordAdvanceModal period={period} onClose={() => setRecording(false)} onDone={() => { setRecording(false); q.reload(); }} />}
    </>
  );
}

export type RepayMode = "lump" | "split" | "fixed";

/** The per-month deduction the chosen mode implies, in sen (null = lump sum),
 * or a string error when the inputs are not yet valid. Mirrors the server. */
export function installmentFromInputs(mode: RepayMode, amountSen: number, months: string, monthly: string): number | null | string {
  if (mode === "lump") return null;
  if (mode === "split") {
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1) return "Enter how many months (1 or more).";
    return Math.ceil(amountSen / n);
  }
  const perMonth = senFromRm(monthly);
  if (!(perMonth > 0)) return "Enter the monthly repayment.";
  if (perMonth > amountSen) return "The monthly repayment can't be more than the advance.";
  return perMonth;
}

function RecordAdvanceModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const employees = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(`${period}-01` <= todayMY() ? todayMY() : `${period}-01`);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<RepayMode>("lump");
  const [months, setMonths] = useState("");
  const [monthly, setMonthly] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => (employees.data?.employees ?? []).filter((e) => e.status === "ACTIVE"), [employees.data]);

  const amountSen = senFromRm(amount);
  const installment = installmentFromInputs(mode, amountSen, months, monthly);
  // A preview of the schedule once both the amount and a valid plan are in.
  const preview =
    mode === "lump" || !(amountSen > 0) || typeof installment === "string" || installment == null
      ? null
      : `RM ${rmFromSen(installment)}/month · about ${Math.ceil(amountSen / installment)} month${Math.ceil(amountSen / installment) === 1 ? "" : "s"}`;

  async function save() {
    if (!employeeId) { toast.error("Pick the employee."); return; }
    if (!(amountSen > 0)) { toast.error("The amount must be more than RM 0.00."); return; }
    if (typeof installment === "string") { toast.error(installment); return; }
    setBusy(true);
    try {
      await api.post(`${HR}/advances`, { employeeId: Number(employeeId), date, amountSen, installmentSen: installment, note });
      toast.success("Advance recorded");
      onDone();
    } catch (e) {
      toast.error(errText(e, "Could not record the advance."));
      setBusy(false);
    }
  }

  const fieldCls = "h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink focus:border-primary focus:outline-none";
  const modeBtn = (m: RepayMode, label: string) =>
    <button type="button" onClick={() => setMode(m)} className={`h-8 flex-1 rounded-md border px-2 text-[11.5px] font-semibold ${mode === m ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface-2 text-ink-secondary hover:border-primary/40"}`}>{label}</button>;
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(17,20,15,.42)" }} onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[440px] animate-rise rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-bold text-ink">Record advance</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">✕</button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Employee</span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={fieldCls}>
              <option value="">--</option>
              {active.map((e) => <option key={e.id} value={e.id}>{e.empNo} {e.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Date given</span>
              <DateField fullWidth value={date} onChange={setDate} aria-label="Date given" />
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Amount (RM)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={fieldCls} />
            </label>
          </div>
          <div className="block">
            <span className="mb-1 block text-[11px] text-ink-muted">Repayment</span>
            <div className="flex gap-2">
              {modeBtn("lump", "Lump sum")}
              {modeBtn("split", "Split N months")}
              {modeBtn("fixed", "Fixed / month")}
            </div>
            {mode === "split" && (
              <label className="mt-2 block"><span className="mb-1 block text-[11px] text-ink-muted">Number of months</span>
                <input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" placeholder="e.g. 5" className={fieldCls} />
              </label>
            )}
            {mode === "fixed" && (
              <label className="mt-2 block"><span className="mb-1 block text-[11px] text-ink-muted">Deduct each month (RM)</span>
                <input value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" placeholder="e.g. 200.00" className={fieldCls} />
              </label>
            )}
            <p className="mt-1.5 text-[11px] text-ink-muted">{mode === "lump" ? "Whole amount comes off the slip of the month it was given." : preview ?? "Enter the amount and a plan to preview the schedule."}</p>
          </div>
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={fieldCls} />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className={hrSecondaryBtn}>Cancel</button>
          <button type="button" disabled={busy || !employeeId || !amount} onClick={() => void save()} className={hrPrimaryBtn}>{busy ? "Saving…" : "Record advance"}</button>
        </div>
      </div>
    </div>
  );
}
