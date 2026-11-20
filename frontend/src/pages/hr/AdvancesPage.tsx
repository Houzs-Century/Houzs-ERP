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
import { HR, senFromRm, useAdvances, useEmployees, type Advance } from "./hrApi";

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
  const unsettled = rows.filter((a) => a.status === "UNSETTLED");
  const outstanding = unsettled.reduce((s, a) => s + a.amountSen, 0);

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
    { key: "date", label: "Date", render: (a) => <span className="font-mono">{formatDate(a.date)}</span> },
    { key: "emp", label: "Employee", render: (a) => <span><span className="font-mono text-[11px] font-semibold text-accent">{a.empNo}</span> <span className="text-ink">{a.name}</span></span> },
    { key: "amount", label: "Amount", align: "right", render: (a, show) => <span className="font-money text-ink">{mask(fmtSen(a.amountSen), show)}</span> },
    { key: "note", label: "Note", render: (a) => <span className="text-ink-secondary">{a.note || "—"}</span> },
    { key: "status", label: "Status", render: (a) => (a.status === "SETTLED" ? <Tag tone="ok">Settled</Tag> : <Tag tone="warn">To deduct</Tag>) },
    { key: "actions", label: "", align: "right", render: (a) => (canManage && a.status === "UNSETTLED" ? <button type="button" onClick={() => void remove(a)} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-err/40 hover:text-err">Remove</button> : null) },
  ];

  return (
    <>
      <HrTablePage<Advance>
        title="Advances"
        subtitle="Cash given ahead of payday, recovered in full"
        actions={canManage ? <button type="button" className={hrPrimaryBtn} onClick={() => setRecording(true)}>+ Record advance</button> : undefined}
        stats={[
          { label: "Outstanding", value: (s) => <span className="font-money">{mask(fmtSen(outstanding), s)}</span>, sub: "to deduct this month", bar: "bg-time" },
          { label: "Unsettled", value: () => unsettled.length, sub: "not yet recovered", bar: "bg-primary" },
          { label: "This month", value: () => rows.length, sub: "advances given", bar: "bg-synced" },
          { label: "Total given", value: (s) => <span className="font-money">{mask(fmtSen(q.data?.totalSen ?? 0), s)}</span>, sub: "this month", bar: "bg-accent" },
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
        footer={(s) => <>outstanding <span className="font-money font-semibold text-ink">{mask(fmtSen(outstanding), s)}</span></>}
      />
      {recording && <RecordAdvanceModal period={period} onClose={() => setRecording(false)} onDone={() => { setRecording(false); q.reload(); }} />}
    </>
  );
}

function RecordAdvanceModal({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const employees = useEmployees();
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(`${period}-01` <= todayMY() ? todayMY() : `${period}-01`);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => (employees.data?.employees ?? []).filter((e) => e.status === "ACTIVE"), [employees.data]);

  async function save() {
    const amountSen = senFromRm(amount);
    if (!employeeId) { toast.error("Pick the employee."); return; }
    if (!(amountSen > 0)) { toast.error("The amount must be more than RM 0.00."); return; }
    setBusy(true);
    try {
      await api.post(`${HR}/advances`, { employeeId: Number(employeeId), date, amountSen, note });
      toast.success("Advance recorded");
      onDone();
    } catch (e) {
      toast.error(errText(e, "Could not record the advance."));
      setBusy(false);
    }
  }

  const fieldCls = "h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12.5px] text-ink focus:border-primary focus:outline-none";
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
