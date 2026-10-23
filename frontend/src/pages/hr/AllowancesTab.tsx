/* Employees & Attendance > Allowances (HC-0125 phase 5): the monthly lines
 * Nico listed (leadership, transport, overnight, KPI) for one month or every
 * month from a start, and Backpay (company advance), which is deducted. The
 * list shows what is in force for the month picked; a line an approved
 * payroll already paid can only have its last month set. */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { ALLOWANCE_KINDS, HR, rmFromSen, senFromRm, useAllowances, useEmployees, type Allowance, type AllowanceKind } from "./hrApi";

type Draft = { id: number | null; employeeId: string; kind: AllowanceKind; amount: string; fromPeriod: string; untilPeriod: string; everyMonth: boolean; note: string };

export function AllowancesTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const today = todayMY();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : today.slice(0, 7);
  const q = useAllowances(period);
  const employees = useEmployees();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = q.data?.canManage ?? false;

  async function save() {
    if (!draft) return;
    const amountSen = senFromRm(draft.amount);
    if (!(amountSen > 0)) {
      toast.error("The amount must be more than RM 0.00.");
      return;
    }
    const body = {
      employeeId: Number(draft.employeeId),
      kind: draft.kind,
      amountSen,
      fromPeriod: draft.fromPeriod,
      untilPeriod: draft.everyMonth ? (draft.untilPeriod || null) : draft.fromPeriod,
      note: draft.note,
    };
    setBusy(true);
    try {
      if (draft.id) await api.patch(`${HR}/allowances/${draft.id}`, body);
      else await api.post(`${HR}/allowances`, body);
      toast.success("Allowance saved");
      setDraft(null);
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not save the allowance."));
    } finally {
      setBusy(false);
    }
  }

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

  const months = (a: Allowance) => (a.untilPeriod === a.fromPeriod ? a.fromPeriod : `${a.fromPeriod} to ${a.untilPeriod ?? "every month"}`);
  const columns: Column<Allowance>[] = [
    { key: "empNo", label: "Emp No", getValue: (a) => a.empNo, render: (a) => <span className="font-mono text-[11px] font-semibold text-accent">{a.empNo}</span> },
    { key: "name", label: "Name", getValue: (a) => a.name, render: (a) => a.name },
    { key: "kind", label: "Type", getValue: (a) => a.label, render: (a) => (a.kind === "BACKPAY" ? <Pill tone="warn">{a.label}</Pill> : a.label) },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      getValue: (a) => (a.kind === "BACKPAY" ? -a.amountSen : a.amountSen),
      render: (a) => <span className={`font-mono ${a.kind === "BACKPAY" ? "text-err" : ""}`}>{a.kind === "BACKPAY" ? `-${fmtSen(a.amountSen)}` : fmtSen(a.amountSen)}</span>,
    },
    { key: "months", label: "Months", getValue: (a) => months(a), render: (a) => <span className="font-mono text-[11px]">{months(a)}</span> },
    { key: "note", label: "Note", getValue: (a) => a.note ?? "", render: (a) => a.note ?? "" },
    {
      key: "actions",
      label: "",
      disableSort: true,
      getValue: () => "",
      render: (a) =>
        canManage ? (
          <span className="inline-flex gap-2">
            <button
              type="button"
              className="text-ink-muted hover:text-accent"
              aria-label={`Edit ${a.empNo} ${a.label}`}
              onClick={() =>
                setDraft({
                  id: a.id,
                  employeeId: String(a.employeeId),
                  kind: a.kind,
                  amount: rmFromSen(a.amountSen),
                  fromPeriod: a.fromPeriod,
                  untilPeriod: a.untilPeriod ?? "",
                  everyMonth: a.untilPeriod !== a.fromPeriod,
                  note: a.note ?? "",
                })
              }
            >
              <Pencil size={12} />
            </button>
            <button type="button" className="text-ink-muted hover:text-err" aria-label={`Remove ${a.empNo} ${a.label}`} onClick={() => void remove(a)}>
              <Trash2 size={12} />
            </button>
          </span>
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
        {q.data && (
          <span className="pb-2 text-[11px] text-ink-secondary">
            {fmtSen(q.data.paidSen)} paid, {fmtSen(q.data.deductedSen)} backpay deducted this month
          </span>
        )}
        {canManage && !draft && (
          <span className="ml-auto pb-1">
            <button
              type="button"
              className={primaryBtn}
              onClick={() => setDraft({ id: null, employeeId: "", kind: "LEADERSHIP", amount: "", fromPeriod: period, untilPeriod: "", everyMonth: true, note: "" })}
            >
              <Plus size={11} /> Add allowance
            </button>
          </span>
        )}
      </div>
      {draft && (
        <div className="grid grid-cols-[1fr_170px_110px_120px_150px_1fr_auto] items-end gap-2 rounded-md border border-border bg-surface p-3 max-md:grid-cols-1">
          <Field label="Employee">
            <select className={inputCls} value={draft.employeeId} disabled={draft.id != null} onChange={(e) => setDraft({ ...draft, employeeId: e.target.value })}>
              <option value="">--</option>
              {(employees.data?.employees ?? [])
                .filter((e) => e.status === "ACTIVE" || String(e.id) === draft.employeeId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.empNo} {e.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Type">
            <select className={inputCls} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as AllowanceKind })}>
              {ALLOWANCE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount (RM)">
            <input className={inputCls} value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="From month">
            <input type="month" className={inputCls} value={draft.fromPeriod} onChange={(e) => e.target.value && setDraft({ ...draft, fromPeriod: e.target.value })} />
          </Field>
          <Field label={draft.everyMonth ? "Until (blank = ongoing)" : "Only that month"}>
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={draft.everyMonth} onChange={(e) => setDraft({ ...draft, everyMonth: e.target.checked })} aria-label="Every month" />
              {draft.everyMonth && <input type="month" className={inputCls} value={draft.untilPeriod} onChange={(e) => setDraft({ ...draft, untilPeriod: e.target.value })} />}
            </span>
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
      <DataTable<Allowance>
        tableId="hr-allowances"
        columns={columns}
        rows={q.data ? q.data.allowances : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No allowance this month."
        getRowKey={(a) => a.id}
        exportName={`allowances-${period}`}
      />
    </div>
  );
}
