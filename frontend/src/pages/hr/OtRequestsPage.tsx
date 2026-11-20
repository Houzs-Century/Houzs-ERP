/* HR · OT Requests (redesign stage 6). Overtime workers/supervisors submit,
 * approved before payroll. Four stat cards, filter chips (Pending / Approved /
 * Rejected / All), a table with a 06:00-22:00 time bar per window, and
 * Approve / Reject. Est. pay is 1.5x hourly (weekday) and masked by default.
 * Sample data. */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { avatarColor, initials } from "./hrSampleData";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const BAR_START = 6 * 60, BAR_END = 22 * 60, BAR_SPAN = BAR_END - BAR_START;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

type Status = "PENDING" | "APPROVED" | "REJECTED";
type OtReq = { id: number; name: string; empNo: string; date: string; sent: string; startMin: number; endMin: number; reason: string; status: Status; by?: string };

const HOURLY = 1200; // sample RM 12.00/h in sen
const paySen = (r: OtReq) => Math.round(((r.endMin - r.startMin) / 60) * HOURLY * 1.5);

const SEED: OtReq[] = [
  { id: 1, name: "Faslie Anak Dennis", empNo: "HC0006", date: "11/20", sent: "11/20 07:55", startMin: 18 * 60, endMin: 21 * 60, reason: "Outstation delivery · Seremban", status: "PENDING" },
  { id: 2, name: "Muhammad Shahfwan", empNo: "HC0008", date: "11/19", sent: "11/19 16:40", startMin: 17 * 60 + 30, endMin: 20 * 60 + 30, reason: "Container unloading", status: "PENDING" },
  { id: 3, name: "Md Sukkur Ali", empNo: "HCFW0004", date: "11/21", sent: "11/19 15:10", startMin: 9 * 60, endMin: 15 * 60, reason: "Saturday stock count", status: "PENDING" },
  { id: 4, name: "Mohd Zaimir Bin Mohd Sharani", empNo: "HC0014", date: "11/18", sent: "11/18 17:05", startMin: 18 * 60, endMin: 20 * 60, reason: "Late delivery · Klang", status: "PENDING" },
  { id: 5, name: "Mia Md Kaiyum", empNo: "HCFW0002", date: "11/15", sent: "11/15 20:10", startMin: 19 * 60, endMin: 21 * 60 + 30, reason: "Rushed an order", status: "APPROVED", by: "Nico" },
  { id: 6, name: "Rafi Shamim Hasnat", empNo: "HCFW0001", date: "11/14", sent: "11/14 18:30", startMin: 18 * 60, endMin: 20 * 60, reason: "Warehouse tidy-up", status: "APPROVED", by: "Nico" },
  { id: 7, name: "Md Billal Hossain", empNo: "HCFW0003", date: "11/12", sent: "11/12 21:00", startMin: 20 * 60, endMin: 22 * 60, reason: "Could not verify hours", status: "REJECTED", by: "Hana" },
];

const FILTERS: { key: "PENDING" | "APPROVED" | "REJECTED" | "ALL"; label: string }[] = [
  { key: "PENDING", label: "Pending" }, { key: "APPROVED", label: "Approved" }, { key: "REJECTED", label: "Rejected" }, { key: "ALL", label: "All" },
];
const STATUS_PILL: Record<Status, { cls: string; label: string }> = {
  PENDING: { cls: "bg-warning-bg text-warning-text", label: "Pending" },
  APPROVED: { cls: "bg-synced-bg text-synced", label: "Approved" },
  REJECTED: { cls: "bg-err-bg text-err", label: "Rejected" },
};

function Avatar({ name }: { name: string }) {
  return <span className={cx("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", avatarColor(name))}>{initials(name)}</span>;
}
function TimeBar({ r }: { r: OtReq }) {
  const left = ((r.startMin - BAR_START) / BAR_SPAN) * 100;
  const width = ((r.endMin - r.startMin) / BAR_SPAN) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-full min-w-[120px] rounded-full bg-surface-2">
        <div className="absolute top-0 h-2 rounded-full bg-accent" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[11px] text-ink-muted">{hhmm(r.startMin)}–{hhmm(r.endMin)}</span>
    </div>
  );
}

export function OtRequestsPage({ fromERPHref }: { fromERPHref?: string }) {
  void fromERPHref;
  const [rows, setRows] = useState<OtReq[]>(SEED);
  const [filter, setFilter] = useState<"PENDING" | "APPROVED" | "REJECTED" | "ALL">("PENDING");
  const [query, setQuery] = useState("");
  const [showAmt, setShowAmt] = useState(false);
  const money = (sen: number) => (showAmt ? `RM ${(sen / 100).toFixed(2)}` : "RM ••••••");

  const counts = useMemo(() => ({
    PENDING: rows.filter((r) => r.status === "PENDING").length,
    APPROVED: rows.filter((r) => r.status === "APPROVED").length,
    REJECTED: rows.filter((r) => r.status === "REJECTED").length,
    ALL: rows.length,
  }), [rows]);
  const approvedHrs = rows.filter((r) => r.status === "APPROVED").reduce((s, r) => s + (r.endMin - r.startMin) / 60, 0);
  const approvedPay = rows.filter((r) => r.status === "APPROVED").reduce((s, r) => s + paySen(r), 0);
  const pendingHrs = rows.filter((r) => r.status === "PENDING").reduce((s, r) => s + (r.endMin - r.startMin) / 60, 0);

  const shown = rows.filter((r) => (filter === "ALL" || r.status === filter) && (query === "" || r.name.toLowerCase().includes(query.toLowerCase()) || r.reason.toLowerCase().includes(query.toLowerCase())));
  const decide = (id: number, status: Status) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status, by: "you" } : r)));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat bar="bg-time" label="Pending approval" value={counts.PENDING} sub={`${pendingHrs} h waiting`} />
        <Stat bar="bg-synced" label="Approved this month" value={<span>{approvedHrs} <span className="text-[13px] text-ink-muted">hrs</span></span>} sub={`${counts.APPROVED} requests`} />
        <Stat bar="bg-accent" label="Approved OT pay" value={<span className="font-money">{money(approvedPay)}</span>} sub="1.5× hourly · weekday" />
        <Stat bar="bg-learning" label="Avg approval time" value={<span>5 <span className="text-[13px] text-ink-muted">hrs</span></span>} sub="Submit → decision" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search employee or reason" className="h-8 w-56 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none" />
          <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={cx("h-7 rounded px-2.5 text-[12px] font-semibold", filter === f.key ? "bg-surface text-primary shadow-sm" : "text-ink-muted hover:text-ink")}>
                {f.label}{f.key !== "ALL" ? ` (${counts[f.key]})` : ""}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-ink-muted">{shown.length} rows</span>
          <button type="button" onClick={() => setShowAmt((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">{showAmt ? "Hide amounts" : "Show amounts"}</button>
        </div>

        <div className="thin-scroll min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wide text-ink-muted">
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-4 py-2 text-left">Employee</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">OT date</th>
                <th className="sticky top-0 z-10 w-[240px] border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">Time (06:00 – 22:00)</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-right">Hours</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">Reason</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-right">Est. pay</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-2 py-2 text-left">Status</th>
                <th className="sticky top-0 z-10 border-b border-border-subtle bg-surface-2 px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="hover:bg-row-hover">
                  <td className="border-b border-border-subtle px-4 py-2">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={r.name} />
                      <span className="min-w-0"><span className="block truncate font-semibold text-ink">{r.name}</span><span className="block font-mono text-[10.5px] text-accent">{r.empNo}</span></span>
                    </span>
                  </td>
                  <td className="border-b border-border-subtle px-2 py-2"><div className="font-semibold text-ink">{r.date}</div><div className="text-[10.5px] text-ink-muted">Sent {r.sent}</div></td>
                  <td className="border-b border-border-subtle px-2 py-2"><TimeBar r={r} /></td>
                  <td className="border-b border-border-subtle px-2 py-2 text-right font-semibold text-ink">{(r.endMin - r.startMin) / 60} h</td>
                  <td className="border-b border-border-subtle px-2 py-2 text-ink-secondary">{r.reason}</td>
                  <td className="border-b border-border-subtle px-2 py-2 text-right font-money text-ink">{money(paySen(r))}</td>
                  <td className="border-b border-border-subtle px-2 py-2"><span className={cx("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", STATUS_PILL[r.status].cls)}>{STATUS_PILL[r.status].label}</span></td>
                  <td className="border-b border-border-subtle px-3 py-2 text-right">
                    {r.status === "PENDING" ? (
                      <span className="flex items-center justify-end gap-1.5">
                        <button type="button" onClick={() => decide(r.id, "REJECTED")} className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:bg-surface-2">Reject</button>
                        <button type="button" onClick={() => decide(r.id, "APPROVED")} className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-primary-ink">Approve</button>
                      </span>
                    ) : (
                      <span className="text-[10.5px] text-ink-muted">by {r.by} · just now</span>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-[12px] text-ink-muted">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2 text-[11px]">
          <span className="text-ink-muted">Approved OT pay <span className="font-money font-semibold text-ink">{money(approvedPay)}</span></span>
          <span className="text-ink-soft">Sample data</span>
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
