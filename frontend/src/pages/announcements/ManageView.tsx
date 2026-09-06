import { useMemo } from "react";
import { Search } from "lucide-react";
import { cn, relativeTime } from "../../lib/utils";
import { fmtDateTime } from "../../vendor/shared/format";
import {
  CATEGORY_META,
  INBOX_FILTERS,
  MANAGE_STATUS_META,
  PERSON_STATE_META,
  ackPercent,
  ackRateBarCls,
  audienceLabel,
  categoryOf,
  deptKey,
  docNo,
  filterManageRows,
  isPendingForMe,
  manageStats,
  manageStatus,
  type AckSummary,
  type AcksData,
  type Announcement,
  type InboxFilter,
  type NameLookups,
} from "./announcementModel";

// ────────────────────────────────────────────────────────────────────────────
// ManageView — the poster's view of /announcements (design handoff 2026-09-04,
// screen 2): a 4-up stat strip, the ack-rate table, and a drawer with the
// two-level drill-down (notice → department → person). Presentational, like
// InboxView: the page owns the fetches and passes plain data.
// ────────────────────────────────────────────────────────────────────────────

export type ManageViewProps = {
  items: Announcement[];
  loading: boolean;
  /** { id → { total, acked } } from /ack-summary; null while loading / failed. */
  summary: AckSummary | null;
  addressedIds: ReadonlySet<string>;
  ackedIds: ReadonlySet<string>;
  currentUserId: number | null;
  lookups: NameLookups;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  search: string;
  onSearch: (q: string) => void;
  /** Receipts for the SELECTED notice. */
  receipts: AcksData | null;
  receiptsLoading: boolean;
  /** The department bucket open in the drill-down (deptKey), null = first. */
  drillDept: string | null;
  onDrill: (key: string) => void;
  onRemindPending: (a: Announcement) => void;
  /** Remind only the pending people of one department (mig 20260906T0921). */
  onRemindDept: (a: Announcement, departmentId: number | null, departmentName: string) => void;
  onEscalate: (a: Announcement, departmentId: number | null, departmentName: string) => void;
  /** Hide / show (PATCH isActive) and permanent delete — the poster's row
   *  actions from the old list, kept in the drawer header. */
  onToggleHidden: (a: Announcement) => void;
  onDelete: (a: Announcement) => void;
  className?: string;
};

const EYEBROW = "font-mono text-[10px] font-bold uppercase tracking-wider";
const TH = "px-2.5 py-2 text-left text-[10px] font-bold uppercase tracking-[.08em] text-ink-secondary";
const SECONDARY_BTN =
  "rounded-md border border-border bg-surface text-ink-secondary hover:bg-surface-dim hover:text-ink disabled:opacity-50";

export function ManageView(p: ManageViewProps) {
  const rows = useMemo(
    () =>
      filterManageRows({
        items: p.items,
        addressedIds: p.addressedIds,
        ackedIds: p.ackedIds,
        currentUserId: p.currentUserId,
        filter: p.filter,
        search: p.search,
      }),
    [p.items, p.addressedIds, p.ackedIds, p.currentUserId, p.filter, p.search],
  );
  const stats = useMemo(
    () => manageStats(p.items, p.summary, p.addressedIds, p.ackedIds),
    [p.items, p.summary, p.addressedIds, p.ackedIds],
  );
  const pendingCount = stats.awaitingYou;
  const selected = p.selectedId ? p.items.find((a) => a.id === p.selectedId) ?? null : null;

  return (
    <div className={cn("flex min-h-0 flex-col", p.className)}>
      {/* ── Stat strip ─────────────────────────────────────────────────── */}
      <div className="grid shrink-0 grid-cols-4 gap-3 px-5 pt-4">
        <Stat label="Awaiting you" value={String(stats.awaitingYou)} valueCls="text-err" />
        <Stat label="Live notices" value={String(stats.liveNotices)} />
        <Stat
          label="Avg. ack rate"
          value={stats.avgAckRate == null ? "—" : `${stats.avgAckRate}%`}
        />
        <Stat
          label="Overdue · escalated"
          value={p.summary ? String(stats.escalated) : "—"}
          valueCls="text-warning-text"
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_392px] gap-4 px-5 pb-6 pt-4">
        {/* ── Table ─────────────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
            <label className="flex min-w-[200px] items-center gap-[7px] rounded-md border border-border bg-surface-2 px-[9px] py-1.5">
              <Search size={12} className="shrink-0 text-ink-muted" />
              <input
                type="search"
                value={p.search}
                onChange={(e) => p.onSearch(e.target.value)}
                placeholder="Search announcements"
                aria-label="Search announcements"
                className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-muted"
              />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {INBOX_FILTERS.map((f) => {
                const active = p.filter === f.id;
                const label =
                  f.id === "pending" && pendingCount > 0 ? `${f.label} ${pendingCount}` : f.label;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => p.onFilter(f.id)}
                    aria-pressed={active}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-[650]",
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-surface text-ink-secondary hover:bg-surface-dim",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  <th className={cn(TH, "pl-3.5")}>Category</th>
                  <th className={TH}>Title</th>
                  <th className={TH}>Audience</th>
                  <th className={TH}>Posted</th>
                  <th className={cn(TH, "text-right")}>Ack rate</th>
                  <th className={cn(TH, "pr-3.5")}>Status</th>
                </tr>
              </thead>
              <tbody>
                {p.loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3.5 py-8 text-center text-[12px] text-ink-muted">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3.5 py-8 text-center text-[12px] text-ink-muted">
                      No notices match.
                    </td>
                  </tr>
                ) : (
                  rows.map((a) => (
                    <ManageRow
                      key={a.id}
                      a={a}
                      summary={p.summary?.[a.id] ?? null}
                      summaryLoaded={p.summary != null}
                      pendingForMe={isPendingForMe(a, p.addressedIds, p.ackedIds)}
                      selected={a.id === p.selectedId}
                      lookups={p.lookups}
                      onSelect={() => p.onSelect(a.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-border bg-surface-2 px-3.5 py-[9px] text-[11.5px] text-ink-muted">
            <span>
              Showing {rows.length} of {p.items.length}
            </span>
            <span>Overdue notices escalate to the direct supervisor automatically</span>
          </div>
        </div>

        {/* ── Drawer ────────────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-slab">
          {selected ? (
            <Drawer
              a={selected}
              receipts={p.receipts}
              receiptsLoading={p.receiptsLoading}
              drillDept={p.drillDept}
              onDrill={p.onDrill}
              onRemindPending={() => p.onRemindPending(selected)}
              onRemindDept={(deptId, deptName) => p.onRemindDept(selected, deptId, deptName)}
              onEscalate={(deptId, deptName) => p.onEscalate(selected, deptId, deptName)}
              onToggleHidden={() => p.onToggleHidden(selected)}
              onDelete={() => p.onDelete(selected)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-ink-muted">
              Select a notice to see who has acknowledged it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueCls }: { label: string; value: string; valueCls?: string }) {
  return (
    <div className="flex flex-col gap-[5px] rounded-lg border border-border bg-surface px-3.5 py-3 shadow-stone">
      <span className={cn(EYEBROW, "text-ink-muted")}>{label}</span>
      <span className={cn("font-money text-[26px] font-bold leading-none", valueCls ?? "text-ink")}>
        {value}
      </span>
    </div>
  );
}

function ManageRow({
  a,
  summary,
  summaryLoaded,
  pendingForMe,
  selected,
  lookups,
  onSelect,
}: {
  a: Announcement;
  summary: { total: number; acked: number } | null;
  summaryLoaded: boolean;
  pendingForMe: boolean;
  selected: boolean;
  lookups: NameLookups;
  onSelect: () => void;
}) {
  const meta = CATEGORY_META[categoryOf(a)];
  const pct = summary && summary.total > 0 ? ackPercent(summary.acked, summary.total) : null;
  const status = MANAGE_STATUS_META[manageStatus(a, { pendingForMe, pct })];
  const author = a.createdByName?.trim();
  return (
    <tr
      onClick={onSelect}
      aria-selected={selected}
      className={cn(
        "cursor-pointer border-b border-border-subtle",
        selected ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim",
      )}
    >
      <td className="py-[11px] pl-3.5 pr-2.5">
        <span
          className={cn(
            "inline-flex rounded-full px-2 py-[2px] text-[10px] font-bold uppercase",
            meta.pillCls,
          )}
        >
          {meta.label}
        </span>
      </td>
      <td className="px-2.5 py-[11px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-[650] text-ink">{a.title}</span>
          <span className="font-mono text-[10px] text-ink-muted">
            {docNo(a)}
            {author && ` · ${author}`}
          </span>
        </div>
      </td>
      <td className="px-2.5 py-[11px] text-[12px] text-ink-secondary">{audienceLabel(a, lookups)}</td>
      <td className="px-2.5 py-[11px] font-mono text-[11px] text-ink-secondary">
        {fmtDateTime(a.createdAt)}
      </td>
      <td className="px-2.5 py-[11px] text-right">
        <div className="flex items-center justify-end gap-2">
          <div className="h-[5px] w-14 overflow-hidden rounded-full bg-surface-dim">
            {pct != null && (
              <div className={cn("h-full", ackRateBarCls(pct))} style={{ width: `${pct}%` }} />
            )}
          </div>
          <span className="font-money text-[12px] font-[650] text-ink">
            {pct != null ? `${pct}%` : summaryLoaded ? "—" : "…"}
          </span>
        </div>
      </td>
      <td className="py-[11px] pl-2.5 pr-3.5">
        <span className={cn("inline-flex rounded-full px-2 py-[2px] text-[10px] font-bold", status.cls)}>
          {status.label}
        </span>
      </td>
    </tr>
  );
}

function Drawer({
  a,
  receipts,
  receiptsLoading,
  drillDept,
  onDrill,
  onRemindPending,
  onRemindDept,
  onEscalate,
  onToggleHidden,
  onDelete,
}: {
  a: Announcement;
  receipts: AcksData | null;
  receiptsLoading: boolean;
  drillDept: string | null;
  onDrill: (key: string) => void;
  onRemindPending: () => void;
  onRemindDept: (departmentId: number | null, departmentName: string) => void;
  onEscalate: (departmentId: number | null, departmentName: string) => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const meta = CATEGORY_META[categoryOf(a)];
  const depts = receipts?.byDepartment ?? [];
  const openKey =
    drillDept && depts.some((d) => deptKey(d.id) === drillDept)
      ? drillDept
      : depts.length > 0
        ? deptKey(depts[0].id)
        : null;
  const openDept = depts.find((d) => deptKey(d.id) === openKey) ?? null;
  const people = useMemo(() => {
    if (!receipts || !openDept) return [];
    const inDept = (x: { departmentId?: number | null }) => deptKey(x.departmentId) === openKey;
    const pending = receipts.pending
      .filter(inDept)
      .map((x) => ({ id: x.id, name: x.name, role: x.positionName ?? "", state: x.state ?? "pending" }));
    const acked = receipts.acked
      .filter(inDept)
      .map((x) => ({ id: x.id, name: x.name, role: x.positionName ?? "", state: "confirmed" as const }));
    return [...pending, ...acked];
  }, [receipts, openDept, openKey]);
  const pendingInDept = openDept?.pending ?? 0;

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-[13px]">
        <span
          className={cn(
            "inline-flex self-start rounded-full px-2 py-[2px] text-[10px] font-bold uppercase",
            meta.pillCls,
          )}
        >
          {meta.label}
        </span>
        <span className="text-[15px] font-[680] leading-[1.3] text-ink">{a.title}</span>
        <span className="font-mono text-[10.5px] text-ink-muted">
          {docNo(a)} · {fmtDateTime(a.createdAt)}
        </span>
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={onToggleHidden}
            className={cn(SECONDARY_BTN, "px-2.5 py-1 text-[11px] font-[650]")}
          >
            {a.isActive ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[11px] font-[650] text-err hover:bg-err/5"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-4 py-3.5">
        <div className="flex flex-col gap-[9px] rounded-md border border-border bg-surface-2 p-3">
          <div className="flex items-baseline justify-between">
            <span className={cn(EYEBROW, "text-ink-secondary")}>By department</span>
            <span className="font-money text-[12.5px] font-[650] text-ink">
              {receipts
                ? `${receipts.ackedCount} / ${receipts.total} confirmed`
                : receiptsLoading
                  ? "…"
                  : "—"}
            </span>
          </div>
          {depts.length === 0 ? (
            <span className="text-[11.5px] text-ink-muted">
              {receiptsLoading ? "Loading…" : "Nobody in the audience yet."}
            </span>
          ) : (
            depts.map((d) => {
              const pct = ackPercent(d.acked, d.total);
              const key = deptKey(d.id);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onDrill(key)}
                  aria-pressed={key === openKey}
                  className={cn(
                    "flex flex-col gap-[5px] rounded-md px-[9px] py-[7px] text-left",
                    key === openKey ? "bg-primary-soft" : "bg-surface hover:bg-surface-dim",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-ink">{d.name}</span>
                    <span
                      className={cn(
                        "font-money text-[11.5px] font-[650]",
                        pct < 70 ? "text-warning-text" : "text-ink",
                      )}
                    >
                      {d.acked} / {d.total}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-surface-dim">
                    <div className={cn("h-full", ackRateBarCls(pct))} style={{ width: `${pct}%` }} />
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-2.5 rounded-md border border-border p-3">
          <div className="flex items-center justify-between">
            <span className={cn(EYEBROW, "text-ink-secondary")}>
              {openDept ? `${openDept.name} · pending` : "Pending"}
            </span>
            <span className="font-money text-[11px] text-ink-muted">
              {pendingInDept} {pendingInDept === 1 ? "person" : "people"}
            </span>
          </div>
          {people.length === 0 ? (
            <span className="text-[11.5px] text-ink-muted">
              {openDept ? "Nobody here." : "Pick a department above."}
            </span>
          ) : (
            people.map((x) => {
              const s = PERSON_STATE_META[x.state];
              return (
                <div key={x.id} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-px">
                    <span className="truncate text-[12px] font-semibold text-ink">{x.name}</span>
                    <span className="text-[10.5px] text-ink-muted">{x.role}</span>
                  </div>
                  <span
                    className={cn(
                      "whitespace-nowrap rounded-full px-[7px] py-[2px] font-mono text-[9.5px] font-bold",
                      s.cls,
                    )}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })
          )}
          <div className="flex flex-col gap-[7px] border-t border-border pt-[9px]">
            <button
              type="button"
              onClick={() => openDept && onRemindDept(openDept.id, openDept.name)}
              disabled={!openDept || pendingInDept === 0}
              className={cn(SECONDARY_BTN, "px-2.5 py-[7px] text-[11.5px] font-[650]")}
            >
              {openDept ? `Remind ${openDept.name} pending` : "Remind department pending"}
              {pendingInDept > 0 && ` (${pendingInDept})`}
            </button>
            <button
              type="button"
              onClick={onRemindPending}
              disabled={!receipts || receipts.pending.length === 0}
              className={cn(SECONDARY_BTN, "px-2.5 py-[7px] text-[11.5px] font-[650]")}
            >
              Remind all pending
              {receipts && receipts.pending.length > 0 && ` (${receipts.pending.length})`}
            </button>
            <button
              type="button"
              onClick={() => openDept && onEscalate(openDept.id, openDept.name)}
              disabled={!openDept || pendingInDept === 0}
              className={cn(SECONDARY_BTN, "px-2.5 py-[7px] text-[11.5px] font-[650]")}
            >
              Notify their supervisors
            </button>
            <span className="text-[10.5px] text-ink-muted">
              {a.escalatedAt
                ? `Supervisors notified ${relativeTime(a.escalatedAt)} (automatic once a notice is 48h overdue)`
                : "Supervisors are notified automatically once the notice is 48h overdue."}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
