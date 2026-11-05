/* Employees & Attendance > Advances (HC-0125 phase 4), from Hookka's
 * AdvancesTab: cash given ahead of payday, taken back in full from the slip
 * of the month it was given (no instalments, as in Hookka). Approving that
 * month settles it; only an unsettled advance can be changed. */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, senFromRm, useAdvances, useEmployees, type Advance } from "./hrApi";

export function AdvancesTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const q = useAdvances(period);
  const employees = useEmployees();
  const [draft, setDraft] = useState<{ employeeId: string; date: string; amount: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = q.data?.canManage ?? false;

  async function save() {
    if (!draft) return;
    const amountSen = senFromRm(draft.amount);
    if (!(amountSen > 0)) {
      toast.error("The amount must be more than RM 0.00.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`${HR}/advances`, { employeeId: Number(draft.employeeId), date: draft.date, amountSen, note: draft.note });
      toast.success("Advance recorded");
      setDraft(null);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not record the advance."));
    } finally {
      setBusy(false);
    }
  }

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

  const columns: Column<Advance>[] = [
    { key: "date", label: "Date", getValue: (a) => a.date, render: (a) => <span className="font-mono">{formatDate(a.date)}</span> },
    { key: "empNo", label: "Emp No", getValue: (a) => a.empNo, render: (a) => <span className="font-mono text-[11px] font-semibold text-accent">{a.empNo}</span> },
    { key: "name", label: "Name", getValue: (a) => a.name, render: (a) => a.name },
    { key: "amount", label: "Amount", align: "right", getValue: (a) => a.amountSen, render: (a) => <span className="font-mono">{fmtSen(a.amountSen)}</span>, total: (r) => fmtSen(r.reduce((s, a) => s + a.amountSen, 0)) },
    { key: "note", label: "Note", getValue: (a) => a.note ?? "", render: (a) => a.note ?? "" },
    { key: "status", label: "Status", getValue: (a) => a.status, render: (a) => (a.status === "SETTLED" ? <Pill tone="ok">Settled</Pill> : <Pill tone="warn">To deduct</Pill>) },
    {
      key: "actions",
      label: "",
      disableSort: true,
      getValue: () => "",
      render: (a) =>
        canManage && a.status === "UNSETTLED" ? (
          <button type="button" className="text-ink-muted hover:text-err" aria-label={`Remove ${a.empNo} advance`} onClick={() => void remove(a)}>
            <Trash2 size={12} />
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month" className="w-40">
          <input
            type="month"
            className={inputCls}
            value={period}
            onChange={(e) =>
              e.target.value &&
              setParams(
                (x) => {
                  const n = new URLSearchParams(x);
                  n.set("period", e.target.value);
                  return n;
                },
                { replace: true },
              )
            }
          />
        </Field>
        {q.data && <span className="pb-2 text-[11px] text-ink-secondary">{fmtSen(q.data.totalSen)} advanced this month</span>}
        {canManage && !draft && (
          <span className="ml-auto pb-1">
            <button type="button" className={primaryBtn} onClick={() => setDraft({ employeeId: "", date: today, amount: "", note: "" })}>
              <Plus size={11} /> Record advance
            </button>
          </span>
        )}
      </div>
      {draft && (
        <div className="grid grid-cols-[1fr_150px_120px_1fr_auto] items-end gap-2 rounded-md border border-border bg-surface p-3 max-md:grid-cols-1">
          <Field label="Employee">
            <select className={inputCls} value={draft.employeeId} onChange={(e) => setDraft({ ...draft, employeeId: e.target.value })}>
              <option value="">--</option>
              {(employees.data?.employees ?? [])
                .filter((e) => e.status === "ACTIVE")
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.empNo} {e.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Date given">
            <DateField fullWidth value={draft.date} onChange={(iso) => setDraft({ ...draft, date: iso })} aria-label="Date given" />
          </Field>
          <Field label="Amount (RM)">
            <input className={inputCls} value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="Note">
            <input className={inputCls} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          </Field>
          <span className="flex gap-2">
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className={primaryBtn} disabled={busy || !draft.employeeId || !draft.amount} onClick={() => void save()}>
              Save
            </button>
          </span>
        </div>
      )}
      <DataTable<Advance>
        tableId="hr-advances"
        columns={columns}
        rows={q.data ? q.data.advances : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No advances given this month."
        getRowKey={(a) => a.id}
        exportName={`advances-${period}`}
      />
    </div>
  );
}
