/* Employees & Attendance > Overtime (HC-0125): the desktop half of the phone
 * Overtime tab. A month view of every OT window workers reported, any status,
 * so HR confirms on the computer and can review a whole month at once.
 * Confirmed overtime is what payroll pays. Gated on hr.ot.confirm (the tab is
 * not mounted without it); the server re-checks on every review. */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { DataTable, type Column } from "../../components/DataTable";
import { useQuery } from "../../hooks/useQuery";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { minToHhmm } from "../../vendor/shared/hr-pay-rules";
import { Field, Pill, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";

type OtStatus = "PENDING" | "CONFIRMED" | "REJECTED";
type OtClaim = {
  id: number;
  workDate: string;
  startMin: number;
  endMin: number;
  note: string;
  status: OtStatus;
  rejectReason: string | null;
  employeeName: string;
  empNo: string;
  reviewedAt: string | null;
};
type OtAdmin = { month: string; claims: OtClaim[] };

const windowLabel = (c: OtClaim) => `${minToHhmm(c.startMin)}-${minToHhmm(c.endMin % 1440)}${c.endMin >= 1440 ? " (+1)" : ""}`;
const minutesOf = (c: OtClaim) => c.endMin - c.startMin;
const hoursLabel = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
};
const STATUS_PILL: Record<OtStatus, { tone: "ok" | "warn" | "bad"; label: string }> = {
  PENDING: { tone: "warn", label: "Waiting" },
  CONFIRMED: { tone: "ok", label: "Confirmed" },
  REJECTED: { tone: "bad", label: "Rejected" },
};

export function OvertimeTab() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : todayMY().slice(0, 7);
  const q = useQuery<OtAdmin>(["attendance-ot-admin", period], () => api.get<OtAdmin>(`/api/attendance/ot/admin?month=${period}`), [period], { keepPreviousData: true });
  const [emp, setEmp] = useState("");
  const [status, setStatus] = useState<"" | OtStatus>("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const setPeriod = (next: string) =>
    next &&
    setParams(
      (x) => {
        const n = new URLSearchParams(x);
        n.set("period", next);
        return n;
      },
      { replace: true },
    );

  const claims = q.data?.claims ?? [];
  const employees = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of claims) if (!seen.has(c.empNo)) seen.set(c.empNo, c.employeeName);
    return [...seen].map(([empNo, name]) => ({ empNo, name }));
  }, [claims]);
  const rows = claims.filter((c) => (!emp || c.empNo === emp) && (!status || c.status === status));
  const pendingCount = claims.filter((c) => c.status === "PENDING").length;
  const confirmedMin = claims.filter((c) => c.status === "CONFIRMED").reduce((s, c) => s + minutesOf(c), 0);

  async function review(c: OtClaim, decision: "confirm" | "reject") {
    if (decision === "reject" && !(await dialog.confirm({ title: `Reject ${c.empNo} ${c.employeeName}'s overtime ${formatDate(c.workDate)} ${windowLabel(c)}?`, confirmLabel: "Reject", tone: "danger" }))) return;
    setBusyId(c.id);
    try {
      await api.post(`/api/attendance/ot/${c.id}/review`, { decision, reason: "" });
      toast.success(decision === "confirm" ? "Overtime confirmed" : "Overtime rejected");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not update that overtime."));
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<OtClaim>[] = [
    { key: "date", label: "Date", getValue: (c) => c.workDate, render: (c) => <span className="font-mono">{formatDate(c.workDate)}</span> },
    { key: "empNo", label: "Emp No", getValue: (c) => c.empNo, render: (c) => <span className="font-mono text-[11px] font-semibold text-accent">{c.empNo}</span> },
    { key: "name", label: "Name", getValue: (c) => c.employeeName, render: (c) => c.employeeName },
    { key: "window", label: "Window", getValue: (c) => c.startMin, render: (c) => <span className="font-mono">{windowLabel(c)}</span> },
    { key: "hours", label: "Hours", align: "right", getValue: (c) => minutesOf(c), render: (c) => <span className="font-mono">{hoursLabel(minutesOf(c))}</span> },
    { key: "note", label: "What they did", getValue: (c) => c.note, render: (c) => c.note || <span className="text-ink-muted">—</span> },
    {
      key: "status",
      label: "Status",
      getValue: (c) => c.status,
      render: (c) => (
        <span className="inline-flex items-center gap-1">
          <Pill tone={STATUS_PILL[c.status].tone}>{STATUS_PILL[c.status].label}</Pill>
          {c.status === "REJECTED" && c.rejectReason ? <span className="text-[11px] text-ink-muted">{c.rejectReason}</span> : null}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      disableSort: true,
      getValue: () => "",
      render: (c) =>
        c.status === "PENDING" ? (
          <span className="flex justify-end gap-1">
            <button type="button" className={primaryBtn} disabled={busyId === c.id} onClick={() => void review(c, "confirm")}>
              Confirm
            </button>
            <button type="button" className={ghostBtn} disabled={busyId === c.id} onClick={() => void review(c, "reject")}>
              Reject
            </button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Month" className="w-40">
          <input type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="Employee" className="w-48">
          <select className={inputCls} value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="">All employees</option>
            {employees.map((x) => (
              <option key={x.empNo} value={x.empNo}>
                {x.empNo} {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status" className="w-36">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as "" | OtStatus)}>
            <option value="">All</option>
            <option value="PENDING">Waiting</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </Field>
        {q.data && (
          <span className="pb-2 text-[11px] text-ink-secondary">
            {pendingCount} waiting · {hoursLabel(confirmedMin)} confirmed this month
          </span>
        )}
      </div>
      <DataTable<OtClaim>
        tableId="hr-overtime"
        columns={columns}
        rows={q.data ? rows : null}
        loading={q.loading}
        error={q.error}
        emptyLabel="No overtime reported for this month."
        getRowKey={(c) => c.id}
        exportName={`overtime-${period}`}
      />
    </div>
  );
}
