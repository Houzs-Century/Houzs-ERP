/* HR · Leave (请假) — desktop. Reuses the self-service leave API that the phone
 * already uses (GET/POST/DELETE /api/attendance/leave, POST .../:id/review):
 *  - My requests: four count cards, a filterable table, apply, cancel a pending
 *    one, CSV export.
 *  - Approvers (hr.leave.approve, from the read's canApprove): a pending-approval
 *    queue with approve / reject; an approval stamps the days onto attendance,
 *    which payroll already prices.
 * The backend tracks no leave balance and no named policies (see the
 * hr_leave_requests migration), so this page shows neither — it is requests and
 * approvals only. */
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { useDialog } from "../../hooks/useDialog";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { DateField } from "../../vendor/scm/components/DateField";
import { Field, Pill, dangerBtn, errText, ghostBtn, inputCls, primaryBtn } from "../pos-admin/posAdminUi";
import { HrPageHeader, hrPrimaryBtn, hrSecondaryBtn } from "./HrPageHeader";
import { LeaveCalendar, type CalEntry } from "./LeaveCalendar";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type LeaveType = { value: string; label: string; paid: boolean };
type LeaveRow = { id: number; leaveStatus: string; startDate: string; endDate: string; reason: string; status: string; rejectReason: string | null; reviewedByName: string | null; reviewedAt: string | null };
type PendingRow = LeaveRow & { employeeName: string; empNo: string };
type LeaveData = { types: LeaveType[]; canApprove: boolean; mine: LeaveRow[]; pending: PendingRow[]; teamHistory: PendingRow[] };

const LEAVE_URL = "/api/attendance/leave";
const useLeave = () => useQuery(LEAVE_URL, () => api.get<LeaveData>(LEAVE_URL), [], { refetchOnMount: "always", staleTime: 0 });

const TYPE_LABEL = new Map<string, string>([["ANNUAL_LEAVE", "Annual leave"], ["MEDICAL_LEAVE", "Medical leave"], ["UNPAID_LEAVE", "Unpaid leave"]]);
const typeLabel = (s: string, types: LeaveType[]) => types.find((t) => t.value === s)?.label ?? TYPE_LABEL.get(s) ?? s;
const dayCount = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;

function StatusPill({ status }: { status: string }) {
  if (status === "APPROVED") return <Pill tone="ok">Approved</Pill>;
  if (status === "REJECTED") return <Pill tone="bad">Rejected</Pill>;
  return <Pill tone="warn">Pending</Pill>;
}

const STATUS_FILTERS = [
  { value: "ALL", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
];

export function LeavePage() {
  const q = useLeave();
  const toast = useToast();
  const dialog = useDialog();
  const [apply, setApply] = useState(false);
  const [reject, setReject] = useState<PendingRow | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [view, setView] = useState<"list" | "calendar">("list");

  const data = q.data;
  const types = data?.types ?? [];
  const canApprove = data?.canApprove ?? false;
  const mine = data?.mine ?? [];
  const pending = data?.pending ?? [];
  const teamHistory = data?.teamHistory ?? [];
  const today = todayMY().slice(0, 10);

  const counts = useMemo(
    () => ({
      total: mine.length,
      approved: mine.filter((r) => r.status === "APPROVED").length,
      pending: mine.filter((r) => r.status === "PENDING").length,
      rejected: mine.filter((r) => r.status === "REJECTED").length,
    }),
    [mine],
  );

  const filteredMine = useMemo(
    () => mine.filter((r) => (statusFilter === "ALL" || r.status === statusFilter) && (typeFilter === "ALL" || r.leaveStatus === typeFilter)),
    [mine, statusFilter, typeFilter],
  );

  const calEntries: CalEntry[] = useMemo(() => {
    const seen = new Set<number>();
    const out: CalEntry[] = [];
    const add = (r: { id: number; leaveStatus: string; startDate: string; endDate: string; status: string }, name: string) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      out.push({ id: r.id, name, type: r.leaveStatus, startDate: r.startDate, endDate: r.endDate, status: r.status });
    };
    for (const r of teamHistory) if (r.status === "APPROVED") add(r, r.employeeName);
    for (const r of pending) add(r, r.employeeName);
    for (const r of mine) if (r.status !== "REJECTED") add(r, "You");
    return out;
  }, [teamHistory, pending, mine]);

  async function cancelMine(row: LeaveRow) {
    const ok = await dialog.confirm({ title: "Cancel this leave request?", message: `${typeLabel(row.leaveStatus, types)} · ${formatDate(row.startDate)} to ${formatDate(row.endDate)}. Only a pending request can be cancelled.`, confirmLabel: "Cancel request", tone: "danger" });
    if (!ok) return;
    try {
      await api.del(`${LEAVE_URL}/${row.id}`);
      toast.success("Request cancelled");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not cancel the request."));
    }
  }

  async function approve(row: PendingRow) {
    const ok = await dialog.confirm({ title: `Approve ${row.employeeName}'s leave?`, message: `${typeLabel(row.leaveStatus, types)} · ${formatDate(row.startDate)} to ${formatDate(row.endDate)} (${dayCount(row.startDate, row.endDate)} days). Each day is marked on attendance; paid leave is not docked.`, confirmLabel: "Approve", tone: "default" });
    if (!ok) return;
    try {
      await api.post(`${LEAVE_URL}/${row.id}/review`, { decision: "approve", reason: "" });
      toast.success("Leave approved");
      q.reload();
    } catch (e) {
      toast.error(errText(e, "Could not approve the leave."));
    }
  }

  const exportCsv = () => {
    const head = ["Leave Type", "Start", "End", "Days", "Backdated", "Status", "Reason"].join(",");
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = filteredMine.map((r) => [esc(typeLabel(r.leaveStatus, types)), r.startDate, r.endDate, String(dayCount(r.startDate, r.endDate)), r.startDate < today ? "Yes" : "No", r.status, esc(r.reason)].join(","));
    const blob = new Blob([[head, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leave-requests.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <HrPageHeader
        title="Leave"
        subtitle="Requests and approvals"
        actions={
          <span className="flex items-center gap-2">
            <span className="inline-flex overflow-hidden rounded-md border border-border">
              <button type="button" onClick={() => setView("list")} className={cx("h-8 px-3 text-[12px] font-semibold", view === "list" ? "bg-accent text-white" : "bg-surface text-ink-secondary hover:bg-bg")}>List</button>
              <button type="button" onClick={() => setView("calendar")} className={cx("h-8 border-l border-border px-3 text-[12px] font-semibold", view === "calendar" ? "bg-accent text-white" : "bg-surface text-ink-secondary hover:bg-bg")}>Calendar</button>
            </span>
            <button type="button" className={hrSecondaryBtn} onClick={exportCsv} disabled={!data || filteredMine.length === 0}>Export</button>
            <button type="button" className={hrPrimaryBtn} onClick={() => setApply(true)}>Apply for leave</button>
          </span>
        }
      />
      <div className="flex flex-col gap-4 px-6 py-4">
        {q.loading && !data && <div className="py-10 text-center text-[12px] text-ink-muted">Loading…</div>}
        {q.error && <div className="py-10 text-center text-[12px] text-err">{q.error}</div>}

        {data && view === "list" && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card label="Total requests" value={counts.total} dot="bg-primary" />
              <Card label="Approved" value={counts.approved} dot="bg-synced" />
              <Card label="Pending" value={counts.pending} dot="bg-time" />
              <Card label="Rejected" value={counts.rejected} dot="bg-err" />
            </div>

            {canApprove && pending.length > 0 && (
              <section className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-ink">Pending approvals</span>
                  <Pill tone="warn">{pending.length}</Pill>
                </div>
                <div className="thin-scroll overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                        <Th>Employee</Th><Th>Leave Type</Th><Th>Start</Th><Th>End</Th><Th>Days</Th><Th>Reason</Th><Th right>Actions</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.map((r) => (
                        <tr key={r.id} className="border-b border-border-subtle last:border-0 hover:bg-row-hover">
                          <Td><span className="font-semibold text-ink">{r.employeeName}</span><span className="ml-1 font-mono text-[10px] text-accent">{r.empNo}</span></Td>
                          <Td>{typeLabel(r.leaveStatus, types)}</Td>
                          <Td>{formatDate(r.startDate)}{r.startDate < today && <span className="ml-1 text-[9px] text-ink-muted">(backdated)</span>}</Td>
                          <Td>{formatDate(r.endDate)}</Td>
                          <Td>{dayCount(r.startDate, r.endDate)}</Td>
                          <Td><span className="line-clamp-2 max-w-[220px] text-ink-secondary">{r.reason || <span className="text-ink-muted">--</span>}</span></Td>
                          <Td right>
                            <span className="inline-flex gap-1.5">
                              <button type="button" className={primaryBtn} onClick={() => void approve(r)}>Approve</button>
                              <button type="button" className={dangerBtn} onClick={() => setReject(r)}>Reject</button>
                            </span>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-2.5">
                <span className="text-[13px] font-semibold text-ink">My requests</span>
                <span className="ml-auto flex items-center gap-2">
                  <select className={cx(inputCls, "w-auto")} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                    {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <select className={cx(inputCls, "w-auto")} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by leave type">
                    <option value="ALL">All types</option>
                    {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </span>
              </div>
              <div className="thin-scroll overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border-subtle text-left text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                      <Th>Leave Type</Th><Th>Start</Th><Th>End</Th><Th>Days</Th><Th>Backdated</Th><Th>Reason</Th><Th>Status</Th><Th>Reviewed by</Th><Th right>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMine.map((r) => (
                      <tr key={r.id} className="border-b border-border-subtle last:border-0 hover:bg-row-hover">
                        <Td>{typeLabel(r.leaveStatus, types)}</Td>
                        <Td>{formatDate(r.startDate)}</Td>
                        <Td>{formatDate(r.endDate)}</Td>
                        <Td>{dayCount(r.startDate, r.endDate)}</Td>
                        <Td>{r.startDate < today ? "Yes" : "No"}</Td>
                        <Td>
                          <span className="line-clamp-2 max-w-[220px] text-ink-secondary">{r.reason || <span className="text-ink-muted">--</span>}</span>
                          {r.status === "REJECTED" && r.rejectReason && <span className="mt-0.5 block text-[10px] text-err">Rejected: {r.rejectReason}</span>}
                        </Td>
                        <Td><StatusPill status={r.status} /></Td>
                        <Td>{r.status !== "PENDING" && r.reviewedByName ? r.reviewedByName : <span className="text-ink-muted">--</span>}</Td>
                        <Td right>{r.status === "PENDING" && <button type="button" className={ghostBtn} onClick={() => void cancelMine(r)}>Cancel</button>}</Td>
                      </tr>
                    ))}
                    {filteredMine.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-[12px] text-ink-muted">{mine.length === 0 ? "No leave requests yet. Use “Apply for leave”." : "No requests match the filters."}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            {canApprove && teamHistory.length > 0 && (
              <section className="overflow-hidden rounded-xl border border-border bg-surface">
                <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-ink">Team history</span>
                  <span className="text-[11px] text-ink-muted">reviewed leave across the team</span>
                </div>
                <div className="thin-scroll overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border-subtle text-left text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                        <Th>Employee</Th><Th>Leave Type</Th><Th>Start</Th><Th>End</Th><Th>Days</Th><Th>Status</Th><Th>Reviewed by</Th><Th>Reviewed on</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {teamHistory.map((r) => (
                        <tr key={r.id} className="border-b border-border-subtle last:border-0 hover:bg-row-hover">
                          <Td><span className="font-semibold text-ink">{r.employeeName}</span><span className="ml-1 font-mono text-[10px] text-accent">{r.empNo}</span></Td>
                          <Td>{typeLabel(r.leaveStatus, types)}</Td>
                          <Td>{formatDate(r.startDate)}</Td>
                          <Td>{formatDate(r.endDate)}</Td>
                          <Td>{dayCount(r.startDate, r.endDate)}</Td>
                          <Td><StatusPill status={r.status} />{r.status === "REJECTED" && r.rejectReason && <span className="mt-0.5 block text-[10px] text-err">{r.rejectReason}</span>}</Td>
                          <Td>{r.reviewedByName ?? <span className="text-ink-muted">--</span>}</Td>
                          <Td>{r.reviewedAt ? formatDate(r.reviewedAt.slice(0, 10)) : <span className="text-ink-muted">--</span>}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {data && view === "calendar" && <LeaveCalendar entries={calEntries} types={types} />}
      </div>

      {apply && <ApplyModal types={types} onClose={() => setApply(false)} onSaved={() => { setApply(false); q.reload(); }} />}
      {reject && <RejectModal row={reject} types={types} onClose={() => setReject(null)} onSaved={() => { setReject(null); q.reload(); }} />}
    </>
  );
}

function Card({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cx("h-2 w-2 rounded-full", dot)} />
        <span className="text-[12.5px] font-semibold text-ink-secondary">{label}</span>
        <span className="ml-auto text-[20px] font-bold leading-none text-ink">{value}</span>
      </div>
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={cx("px-4 py-2", right && "text-right")}>{children}</th>;
}
function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={cx("px-4 py-2 align-top", right && "text-right")}>{children}</td>;
}

function ApplyModal({ types, onClose, onSaved }: { types: LeaveType[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [leaveType, setLeaveType] = useState(types[0]?.value ?? "ANNUAL_LEAVE");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!start || !end) { toast.error("Pick the first and last day."); return; }
    if (end < start) { toast.error("The last day is before the first day."); return; }
    setBusy(true);
    try {
      await api.post(LEAVE_URL, { leaveType, startDate: start, endDate: end, reason });
      toast.success("Leave applied");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not apply for leave."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4" onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[440px] rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-border-subtle px-5 py-3">
          <h3 className="text-[15px] font-bold text-ink">Apply for leave</h3>
          <p className="text-[11.5px] text-ink-muted">A supervisor approves it; approval marks the days on attendance.</p>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <Field label="Leave type">
            <select className={inputCls} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
              {types.map((t) => <option key={t.value} value={t.value}>{t.label}{t.paid ? "" : " (unpaid)"}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day"><DateField fullWidth value={start} onChange={(iso) => { setStart(iso); if (!end) setEnd(iso); }} aria-label="First day" /></Field>
            <Field label="Last day"><DateField fullWidth value={end} onChange={setEnd} aria-label="Last day" /></Field>
          </div>
          <Field label="Reason"><textarea className={cx(inputCls, "h-16 py-1")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. family trip, fever" /></Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>{busy ? "Applying…" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}

function RejectModal({ row, types, onClose, onSaved }: { row: PendingRow; types: LeaveType[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      await api.post(`${LEAVE_URL}/${row.id}/review`, { decision: "reject", reason });
      toast.success("Leave rejected");
      onSaved();
    } catch (e) {
      toast.error(errText(e, "Could not reject the leave."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4" onMouseDown={onClose}>
      <div className="my-10 w-full max-w-[440px] rounded-2xl bg-surface shadow-[0_24px_64px_-16px_rgba(17,20,15,.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-border-subtle px-5 py-3">
          <h3 className="text-[15px] font-bold text-ink">Reject leave</h3>
          <p className="text-[11.5px] text-ink-muted">{row.employeeName} · {typeLabel(row.leaveStatus, types)} · {formatDate(row.startDate)} to {formatDate(row.endDate)}</p>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <Field label="Reason (optional)" hint="Shown to the employee on their request."><textarea className={cx(inputCls, "h-16 py-1")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. short-staffed that week" /></Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={dangerBtn} disabled={busy} onClick={() => void go()}>{busy ? "Rejecting…" : "Reject"}</button>
        </div>
      </div>
    </div>
  );
}
