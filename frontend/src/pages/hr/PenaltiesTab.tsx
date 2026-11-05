/* Employees & Attendance > Penalty (HC-0125 phase 4), from Hookka's Worker
 * Penalty tab. The reference is free text (Samuel 2026-10-22): a DO number,
 * a lorry plate, an incident; Hookka pointed at a production order. Draft ->
 * submitted -> approved (by someone other than who raised it) -> posted into
 * the payroll month it lands in. Reject sends it back to draft with a
 * reason; revoke takes back an approval not yet in a payslip. */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { ResizableDrawer } from "../../components/ResizableDrawer";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { fmtSen, todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { Field, Pill, dangerBtn, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HR, rmFromSen, senFromRm, useEmployees, usePenalties, type Penalty } from "./hrApi";

const STATUS: Record<Penalty["status"], { label: string; tone: "muted" | "warn" | "info" | "ok" }> = {
  DRAFT: { label: "Draft", tone: "muted" },
  PENDING_APPROVAL: { label: "Waiting approval", tone: "warn" },
  APPROVED: { label: "Approved", tone: "info" },
  POSTED: { label: "In payslip", tone: "ok" },
};

export function PenaltiesTab() {
  const q = usePenalties();
  const [open, setOpen] = useState<Penalty | "new" | null>(null);
  const rows = q.data?.penalties ?? [];
  const columns: Column<Penalty>[] = [
    { key: "no", label: "No", getValue: (p) => p.penaltyNo, render: (p) => <span className="font-mono text-[11px] font-semibold text-accent">{p.penaltyNo}</span> },
    { key: "date", label: "Date", getValue: (p) => p.date, render: (p) => <span className="font-mono">{formatDate(p.date)}</span> },
    { key: "reference", label: "Reference", getValue: (p) => p.reference ?? "", render: (p) => p.reference ?? "" },
    { key: "reason", label: "Reason", getValue: (p) => p.reason, render: (p) => p.reason },
    { key: "who", label: "Who", getValue: (p) => p.lines.map((l) => l.name).join(", "), render: (p) => <span className="text-[11px]">{p.lines.map((l) => `${l.empNo} ${fmtSen(l.amountSen)}`).join(", ")}</span> },
    { key: "total", label: "Total", align: "right", getValue: (p) => p.lines.reduce((s, l) => s + l.amountSen, 0), render: (p) => <span className="font-mono">{fmtSen(p.lines.reduce((s, l) => s + l.amountSen, 0))}</span> },
    { key: "period", label: "Payroll Month", getValue: (p) => p.lines[0]?.payrollPeriod ?? "", render: (p) => p.lines[0]?.payrollPeriod ?? "" },
    { key: "status", label: "Status", getValue: (p) => STATUS[p.status].label, render: (p) => <Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill> },
  ];
  return (
    <div className="space-y-3">
      {q.data?.canManage && (
        <div className="flex justify-end">
          <button type="button" className={primaryBtn} onClick={() => setOpen("new")}>
            <Plus size={11} /> New penalty
          </button>
        </div>
      )}
      <DataTable<Penalty>
        tableId="hr-penalties"
        columns={columns}
        rows={q.data ? rows : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No penalties."
        getRowKey={(p) => p.id}
        onRowClick={(p) => setOpen(p)}
      />
      {open && q.data && (
        <PenaltyDrawer
          penalty={open === "new" ? null : open}
          me={q.data.me}
          canManage={q.data.canManage}
          canApprove={q.data.canApprove}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            q.reload();
          }}
        />
      )}
    </div>
  );
}

function PenaltyDrawer({ penalty, me, canManage, canApprove, onClose, onDone }: { penalty: Penalty | null; me: number; canManage: boolean; canApprove: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const dialog = useDialog();
  const employees = useEmployees();
  const editable = canManage && (!penalty || penalty.status === "DRAFT");
  const [date, setDate] = useState(penalty?.date ?? todayMY());
  const [reference, setReference] = useState(penalty?.reference ?? "");
  const [reason, setReason] = useState(penalty?.reason ?? "");
  const [remarks, setRemarks] = useState(penalty?.remarks ?? "");
  const [lines, setLines] = useState<{ employeeId: string; amount: string }[]>(
    penalty?.lines.map((l) => ({ employeeId: String(l.employeeId), amount: rmFromSen(l.amountSen) })) ?? [{ employeeId: "", amount: "" }],
  );
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => (employees.data?.employees ?? []).filter((e) => e.status === "ACTIVE"), [employees.data]);
  const body = () => ({ date, reference, reason, remarks, lines: lines.map((l) => ({ employeeId: Number(l.employeeId), amountSen: senFromRm(l.amount) })) });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onDone();
    } catch (e) {
      toast.error(errText(e, "Could not update the penalty."));
    } finally {
      setBusy(false);
    }
  };
  const save = (submit: boolean) =>
    run(async () => {
      if (penalty) {
        await api.patch(`${HR}/penalties/${penalty.id}`, body());
        if (submit) await api.post(`${HR}/penalties/${penalty.id}/submit`, {});
      } else {
        await api.post(`${HR}/penalties`, { ...body(), submit });
      }
    }, submit ? "Submitted for approval" : "Penalty saved");
  const step = (action: "approve" | "revoke", ok: string) => run(() => api.post(`${HR}/penalties/${penalty?.id}/${action}`, {}), ok);
  const reject = async () => {
    const why = await dialog.prompt({ title: "Reject the penalty?", message: "It goes back to the person who raised it as a draft.", placeholder: "Why", required: true });
    if (why) await run(() => api.post(`${HR}/penalties/${penalty?.id}/reject`, { reason: why }), "Penalty rejected");
  };
  const remove = async () => {
    if (await dialog.confirm({ title: `Remove ${penalty?.penaltyNo}?`, confirmLabel: "Remove", tone: "danger" })) await run(() => api.del(`${HR}/penalties/${penalty?.id}`), "Penalty removed");
  };

  const own = penalty?.createdBy === me;
  return (
    <ResizableDrawer
      onClose={onClose}
      title={penalty ? <span className="font-mono">{penalty.penaltyNo}</span> : "New penalty"}
      subtitle={penalty ? `${STATUS[penalty.status].label}${penalty.createdByName ? ` · raised by ${penalty.createdByName}` : ""}${penalty.approvedByName ? ` · approved by ${penalty.approvedByName}` : ""}` : "Deducted from the payslip of the month it is approved in."}
      storageKey="hr-penalty-drawer"
      defaultWidth={520}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {penalty?.status === "DRAFT" && canManage && (
            <button type="button" className={dangerBtn} disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
          <span className="ml-auto" />
          <button type="button" className={ghostBtn} onClick={onClose}>
            Close
          </button>
          {editable && (
            <>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => void save(false)}>
                Save draft
              </button>
              <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save(true)}>
                Submit for approval
              </button>
            </>
          )}
          {penalty?.status === "PENDING_APPROVAL" && canApprove && (
            <>
              <button type="button" className={ghostBtn} disabled={busy} onClick={() => void reject()}>
                Reject
              </button>
              <button type="button" className={primaryBtn} disabled={busy || own} title={own ? "Someone other than the person who raised it approves it." : undefined} onClick={() => void step("approve", "Penalty approved")}>
                Approve
              </button>
            </>
          )}
          {penalty?.status === "APPROVED" && canApprove && (
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => void step("revoke", "Approval taken back")}>
              Revoke
            </button>
          )}
        </div>
      }
    >
      <fieldset disabled={!editable} className="space-y-3 p-3">
        {penalty?.rejectedReason && penalty.status === "DRAFT" && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">Rejected: {penalty.rejectedReason}</div>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <DateField fullWidth value={date} onChange={setDate} aria-label="Penalty date" />
          </Field>
          <Field label="Reference" hint="DO no., lorry plate, incident">
            <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason">
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. damaged sofa on delivery" />
        </Field>
        <Field label="Remarks">
          <textarea className={`${inputCls} h-14 py-1`} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary">Who pays</div>
          {lines.map((l, i) => (
            <div key={i} className="mb-1 grid grid-cols-[1fr_110px_24px] items-center gap-2">
              <select className={inputCls} value={l.employeeId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, employeeId: e.target.value } : x)))}>
                <option value="">--</option>
                {active.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.empNo} {e.name}
                  </option>
                ))}
              </select>
              <input className={inputCls} value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="RM" inputMode="decimal" />
              {lines.length > 1 && editable ? (
                <button type="button" className="text-ink-muted hover:text-err" aria-label="Remove person" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <Trash2 size={12} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
          {editable && (
            <button type="button" className={ghostBtn} onClick={() => setLines([...lines, { employeeId: "", amount: "" }])}>
              <Plus size={11} /> Add person
            </button>
          )}
        </div>
      </fieldset>
    </ResizableDrawer>
  );
}
