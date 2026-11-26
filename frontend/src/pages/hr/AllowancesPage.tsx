import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { errText } from "../pos-admin/posAdminUi";
import { hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { HrTablePage, Tag, mask, type HrCol } from "./HrTablePage";
import { ALLOWANCE_KINDS, HR, rmFromSen, senFromRm, useAllowances, useEmployees, type Allowance, type AllowanceKind } from "./hrApi";

const monthInput = "h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none";
const monthsLabel = (a: Allowance) => (a.untilPeriod === a.fromPeriod ? a.fromPeriod : `${a.fromPeriod} → ${a.untilPeriod ?? "ongoing"}`);

export function AllowancesPage() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const q = useAllowances(period);
  const [editing, setEditing] = useState<Allowance | "new" | null>(null);
  const canManage = q.data?.canManage ?? false;

  const setPeriod = (next: string) =>
    next && setParams((x) => { const n = new URLSearchParams(x); n.set("period", next); return n; }, { replace: true });

  const rows = useMemo(() => q.data?.allowances ?? [], [q.data]);
  const recurring = rows.filter((a) => a.untilPeriod !== a.fromPeriod).length;

  async function remove(a: Allowance) {
    if (!(await dialog.confirm({ title: `Remove ${a.empNo}'s ${a.label}?`, confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await api.del(`${HR}/allowances/${a.id}`);
      toast.success("Allowance removed");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not remove the allowance."));
    }
  }

  const columns: HrCol<Allowance>[] = [
    { key: "emp", label: "Employee", getValue: (a) => `${a.name} ${a.empNo}`, render: (a) => <span><span className="font-mono text-[11px] font-semibold text-accent">{a.empNo}</span> <span className="text-ink">{a.name}</span></span> },
    { key: "kind", label: "Type", getValue: (a) => a.label, render: (a) => (a.kind === "BACKPAY" ? <Tag tone="warn">{a.label}</Tag> : <span className="text-ink-secondary">{a.label}</span>) },
    { key: "amount", label: "Amount", align: "right", filterType: "number", getValue: (a) => ((a.kind === "BACKPAY" ? -1 : 1) * a.amountSen) / 100, render: (a, show) => <span className={"font-money " + (a.kind === "BACKPAY" ? "text-err" : "text-ink")}>{a.kind === "BACKPAY" ? `-${mask(fmtSen(a.amountSen), show)}` : mask(fmtSen(a.amountSen), show)}</span> },
    { key: "months", label: "Months", getValue: (a) => monthsLabel(a), render: (a) => <span className="font-mono text-[11px] text-ink-secondary">{monthsLabel(a)}</span> },
    { key: "note", label: "Note", getValue: (a) => a.note ?? "", render: (a) => <span className="text-ink-secondary">{a.note || "—"}</span> },
    { key: "actions", label: "", align: "right", disableSort: true, render: (a) => (canManage ? (
      <span className="inline-flex gap-1.5">
        <button type="button" onClick={() => setEditing(a)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-primary/40 hover:text-primary">Edit</button>
        <button type="button" onClick={() => void remove(a)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-err/40 hover:text-err">Remove</button>
      </span>
    ) : null) },
  ];

  return (
    <>
      <HrTablePage<Allowance>
        title="Allowances"
        subtitle="Leadership, transport, KPI and attendance allowances; Backpay is deducted"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setEditing("new")}>+ Add allowance</button> : undefined}
        stats={[
          { label: "Paid this month", value: (s) => <span className="font-money">{mask(fmtSen(q.data?.paidSen ?? 0), s)}</span>, sub: "allowances", bar: "bg-primary" },
          { label: "Backpay deducted", value: (s) => <span className="font-money text-err">{mask(fmtSen(q.data?.deductedSen ?? 0), s)}</span>, sub: "company advances", bar: "bg-err" },
          { label: "Lines", value: () => rows.length, sub: "in force this month", bar: "bg-synced" },
          { label: "Recurring", value: () => recurring, sub: "every-month lines", bar: "bg-accent" },
        ]}
        moneyToggle
        toolbarExtra={<input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className={monthInput} />}
        rows={rows}
        columns={columns}
        searchOf={(a) => `${a.name} ${a.empNo} ${a.label} ${a.note ?? ""}`}
        searchPlaceholder="Search employee or type"
        loading={q.loading && !q.data}
        error={q.error}
        emptyLabel="No allowance this month."
        footer={(s) => <>paid <span className="font-money font-semibold text-ink">{mask(fmtSen(q.data?.paidSen ?? 0), s)}</span></>}
      />
      {editing && <AllowanceModal allowance={editing === "new" ? null : editing} period={period} onClose={() => setEditing(null)} onDone={() => { setEditing(null); q.reload(); }} />}
    </>
  );
}

function AllowanceModal({ allowance, period, onClose, onDone }: { allowance: Allowance | null; period: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const employees = useEmployees();
  const [employeeId, setEmployeeId] = useState(allowance ? String(allowance.employeeId) : "");
  const [kind, setKind] = useState<AllowanceKind>(allowance?.kind ?? "LEADERSHIP");
  const [amount, setAmount] = useState(allowance ? rmFromSen(allowance.amountSen) : "");
  const [fromPeriod, setFromPeriod] = useState(allowance?.fromPeriod ?? period);
  const [everyMonth, setEveryMonth] = useState(allowance ? allowance.untilPeriod !== allowance.fromPeriod : true);
  const [untilPeriod, setUntilPeriod] = useState(allowance?.untilPeriod ?? "");
  const [note, setNote] = useState(allowance?.note ?? "");
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => (employees.data?.employees ?? []).filter((e) => e.status === "ACTIVE" || String(e.id) === employeeId), [employees.data, employeeId]);

  async function save() {
    const amountSen = senFromRm(amount);
    if (!employeeId) { toast.error("Pick the employee."); return; }
    if (!(amountSen > 0)) { toast.error("The amount must be more than RM 0.00."); return; }
    setBusy(true);
    try {
      const body = { employeeId: Number(employeeId), kind, amountSen, fromPeriod, untilPeriod: everyMonth ? (untilPeriod || null) : fromPeriod, note };
      if (allowance) await api.patch(`${HR}/allowances/${allowance.id}`, body);
      else await api.post(`${HR}/allowances`, body);
      toast.success("Allowance saved");
      onDone();
    } catch (e) {
      toast.error(errText(e, "Could not save the allowance."));
      setBusy(false);
    }
  }

  const fieldCls = "h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink focus:border-primary focus:outline-none";
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-6" style={{ background: "rgba(17,20,15,.42)" }} onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[480px] animate-rise rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-bold text-ink">{allowance ? "Edit allowance" : "Add allowance"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink">✕</button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Employee</span>
            <select value={employeeId} disabled={allowance != null} onChange={(e) => setEmployeeId(e.target.value)} className={fieldCls}>
              <option value="">--</option>
              {active.map((e) => <option key={e.id} value={e.id}>{e.empNo} {e.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as AllowanceKind)} className={fieldCls}>
                {ALLOWANCE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">{kind === "ATTENDANCE" ? "Amount (RM / day)" : "Amount (RM)"}</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={fieldCls} />
            </label>
          </div>
          {kind === "ATTENDANCE" && <span className="-mt-1 block text-[11px] text-ink-muted">Paid per day attended; the whole month is dropped if late on more than 3 days or any unpaid leave.</span>}
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">From month</span>
              <input type="month" value={fromPeriod} onChange={(e) => e.target.value && setFromPeriod(e.target.value)} className={fieldCls} />
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">{everyMonth ? "Until (blank = ongoing)" : "Only that month"}</span>
              {everyMonth ? <input type="month" value={untilPeriod} onChange={(e) => setUntilPeriod(e.target.value)} className={fieldCls} /> : <div className="flex h-9 items-center text-[12px] text-ink-muted">one month only</div>}
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={everyMonth} onChange={(e) => setEveryMonth(e.target.checked)} /> Every month from the start</label>
          <label className="block"><span className="mb-1 block text-[11px] text-ink-muted">Note</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={fieldCls} />
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className={hrSecondaryBtn}>Cancel</button>
          <button type="button" disabled={busy || !employeeId || !amount} onClick={() => void save()} className={hrPrimaryBtn}>{busy ? "Saving…" : "Save allowance"}</button>
        </div>
      </div>
    </div>
  );
}
