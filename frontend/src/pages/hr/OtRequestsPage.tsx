/* HR · OT Requests (redesign look, real data). The month of overtime windows
 * workers reported on the phone, any status; HR confirms or rejects here and
 * only confirmed overtime is paid (pay itself is computed in Payroll, so there
 * is no amount column on this page). Four stat cards, a month picker, filter
 * chips (Waiting / Confirmed / Rejected / All) with a search, a table with a
 * 06:00-22:00 time bar per window, and Confirm / Reject.
 *
 * Mounted only for hr.ot.confirm (HrEmployees gates it); the server re-checks
 * every review. Endpoint and review match the phone + desktop OT feature
 * (#5849): GET /api/attendance/ot/admin, POST /api/attendance/ot/:id/review. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useDialog } from "../../hooks/useDialog";
import { useToast } from "../../hooks/useToast";
import { formatDate } from "../../lib/utils";
import { todayMY } from "../../vendor/shared/format";
import { avatarColor, initials } from "./hrAvatar";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const BAR_START = 6 * 60, BAR_END = 22 * 60, BAR_SPAN = BAR_END - BAR_START;
const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const windowLabel = (startMin: number, endMin: number) => `${hhmm(startMin)}–${hhmm(endMin)}${endMin >= 1440 ? " (+1)" : ""}`;
const hoursLabel = (min: number) => {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
};

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

type FilterKey = OtStatus | "ALL";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "PENDING", label: "Waiting" }, { key: "CONFIRMED", label: "Confirmed" }, { key: "REJECTED", label: "Rejected" }, { key: "ALL", label: "All" },
];
const STATUS_PILL: Record<OtStatus, { cls: string; label: string }> = {
  PENDING: { cls: "bg-warning-bg text-warning-text", label: "Waiting" },
  CONFIRMED: { cls: "bg-synced-bg text-synced", label: "Confirmed" },
  REJECTED: { cls: "bg-err-bg text-err", label: "Rejected" },
};

function Avatar({ name }: { name: string }) {
  return <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", avatarColor(name))}>{initials(name)}</span>;
}
function TimeBar({ startMin, endMin }: { startMin: number; endMin: number }) {
  const left = clampPct(((startMin - BAR_START) / BAR_SPAN) * 100);
  const width = clampPct(((endMin - startMin) / BAR_SPAN) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-full min-w-[120px] rounded-full bg-surface-2">
        <div className="absolute top-0 h-2 rounded-full bg-accent" style={{ left: `${left}%`, width: `${Math.max(width, 2)}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[11px] text-ink-muted">{windowLabel(startMin, endMin)}</span>
    </div>
  );
}

export function OtRequestsPage() {
  const toast = useToast();
  const dialog = useDialog();
  const [params, setParams] = useSearchParams();
  const period = /^\d{4}-\d{2}$/.test(params.get("period") ?? "") ? (params.get("period") as string) : todayMY().slice(0, 7);
  const q = useQuery<OtAdmin>(["attendance-ot-admin", period], () => api.get<OtAdmin>(`/api/attendance/ot/admin?month=${period}`), [period], { keepPreviousData: true });
  const [filter, setFilter] = useState<FilterKey>("PENDING");
  const [query, setQuery] = useState("");
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

  const claims = useMemo(() => q.data?.claims ?? [], [q.data]);
  const minutesOf = (c: OtClaim) => c.endMin - c.startMin;
  const counts = useMemo(() => ({
    PENDING: claims.filter((c) => c.status === "PENDING").length,
    CONFIRMED: claims.filter((c) => c.status === "CONFIRMED").length,
    REJECTED: claims.filter((c) => c.status === "REJECTED").length,
    ALL: claims.length,
  }), [claims]);
  const pendingMin = claims.filter((c) => c.status === "PENDING").reduce((s, c) => s + minutesOf(c), 0);
  const confirmedMin = claims.filter((c) => c.status === "CONFIRMED").reduce((s, c) => s + minutesOf(c), 0);

  const shown = claims.filter(
    (c) => (filter === "ALL" || c.status === filter) && (query === "" || c.employeeName.toLowerCase().includes(query.toLowerCase()) || c.empNo.toLowerCase().includes(query.toLowerCase()) || c.note.toLowerCase().includes(query.toLowerCase())),
  );

  async function review(c: OtClaim, decision: "confirm" | "reject") {
    if (decision === "reject" && !(await dialog.confirm({ title: `Reject ${c.empNo} ${c.employeeName}'s overtime ${formatDate(c.workDate)} ${windowLabel(c.startMin, c.endMin)}?`, confirmLabel: "Reject", tone: "danger" }))) return;
    setBusyId(c.id);
    try {
      await api.post(`/api/attendance/ot/${c.id}/review`, { decision, reason: "" });
      toast.success(decision === "confirm" ? "Overtime confirmed" : "Overtime rejected");
      q.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update that overtime.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat bar="bg-time" label="Waiting" value={counts.PENDING} sub={`${hoursLabel(pendingMin)} to review`} />
        <Stat bar="bg-synced" label="Confirmed this month" value={<span>{Math.round((confirmedMin / 60) * 10) / 10} <span className="text-[13px] text-ink-muted">hrs</span></span>} sub={`${counts.CONFIRMED} windows`} />
        <Stat bar="bg-err" label="Rejected" value={counts.REJECTED} sub="this month" />
        <Stat bar="bg-primary" label="All windows" value={counts.ALL} sub="reported this month" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-8 rounded-md border border-border bg-surface-2 px-2 text-[12px] text-ink focus:border-primary focus:outline-none" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search employee or reason" className="h-8 w-52 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
          <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", filter === f.key ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>
                {f.label}{f.key !== "ALL" ? ` (${counts[f.key]})` : ""}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-ink-muted">{shown.length} rows</span>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-4 py-2 text-left">Employee</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">OT date</th>
                <th className="sticky top-0 z-10 w-[240px] border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">Time (06:00 – 22:00)</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-right">Hours</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">What they did</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">Status</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="hover:bg-row-hover">
                  <td className="border-b border-border-subtle px-4 py-2">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={c.employeeName} />
                      <span className="min-w-0"><span className="block truncate font-semibold text-ink">{c.employeeName}</span><span className="block font-mono text-[10.5px] text-accent">{c.empNo}</span></span>
                    </span>
                  </td>
                  <td className="border-b border-border-subtle px-2 py-2"><div className="font-semibold text-ink">{formatDate(c.workDate)}</div>{c.reviewedAt && <div className="text-[10.5px] text-ink-muted">Reviewed {formatDate(c.reviewedAt.slice(0, 10))}</div>}</td>
                  <td className="border-b border-border-subtle px-2 py-2"><TimeBar startMin={c.startMin} endMin={c.endMin} /></td>
                  <td className="border-b border-border-subtle px-2 py-2 text-right font-semibold text-ink">{hoursLabel(minutesOf(c))}</td>
                  <td className="border-b border-border-subtle px-2 py-2 text-ink-secondary">{c.note || <span className="text-ink-muted">—</span>}</td>
                  <td className="border-b border-border-subtle px-2 py-2">
                    <span className={cx("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_PILL[c.status].cls)}>{STATUS_PILL[c.status].label}</span>
                    {c.status === "REJECTED" && c.rejectReason ? <span className="ml-1 text-[10.5px] text-ink-muted">{c.rejectReason}</span> : null}
                  </td>
                  <td className="border-b border-border-subtle px-3 py-2 text-right">
                    {c.status === "PENDING" ? (
                      <span className="flex items-center justify-end gap-1.5">
                        <button type="button" disabled={busyId === c.id} onClick={() => void review(c, "reject")} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2 disabled:opacity-50">Reject</button>
                        <button type="button" disabled={busyId === c.id} onClick={() => void review(c, "confirm")} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary-ink disabled:opacity-50">Confirm</button>
                      </span>
                    ) : (
                      <span className="text-[10.5px] text-ink-muted">{STATUS_PILL[c.status].label}</span>
                    )}
                  </td>
                </tr>
              ))}
              {q.loading && <tr><td colSpan={7} className="px-4 py-10 text-center text-[12px] text-ink-muted">Loading…</td></tr>}
              {q.error && !q.loading && <tr><td colSpan={7} className="px-4 py-10 text-center text-[12px] text-err">{q.error}</td></tr>}
              {!q.loading && !q.error && shown.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-[12px] text-ink-muted">No overtime reported for this month.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[11px]">
          <span className="text-ink-muted">{counts.PENDING} waiting · {hoursLabel(confirmedMin)} confirmed this month</span>
          <span className="text-ink-soft">Only confirmed overtime is paid</span>
        </div>
      </div>
    </div>
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
