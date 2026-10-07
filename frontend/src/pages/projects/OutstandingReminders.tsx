import { useMemo, useState } from "react";
import { Copy, ClipboardList } from "lucide-react";
import { api, buildQuery } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { cn } from "../../lib/utils";

/**
 * Projects › Reminder — owner/admin-only chase list (owner 2026-09-30).
 *
 * The owner used to open every project one by one and screenshot the pending
 * checklist tasks to compile a reminder for the WhatsApp group. This view pulls
 * every INCOMPLETE checklist task across all events in one request (server-side
 * gate: the BD / Owner / weisiang tier, routes/lib/named-tier.ts) and lets her:
 *   • drill to ONE task (e.g. "Filled Floorplan" only), not a whole section,
 *   • flip status Incomplete ↔ Overdue-only,
 *   • pick a month,
 *   • narrow to ONE organizer (so a per-organizer chase stays on one screen),
 *   • group by Organizer / Owner / Sales PIC,
 * then copy a clean, ready-to-paste reminder per group or for everything.
 *
 * No WhatsApp API / personal numbers — copying to the clipboard only. She pastes
 * it into the relevant group herself.
 *
 * Task / status / group-by filtering happens client-side on the one payload, so
 * switching group-by is instant; only month triggers a refetch.
 */

export interface OutstandingRow {
  id: number;
  title: string;
  status: string;
  review_status: string | null;
  due_date: string | null;
  overdue_days: number;
  project_id: number;
  code: string;
  name: string;
  brand: string | null;
  organizer: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  start_date: string | null;
  end_date: string | null;
  pic_name: string | null;
  owner_name: string | null;
}

interface OutstandingResponse {
  today: string;
  rows: OutstandingRow[];
}

export type GroupBy = "organizer" | "owner" | "pic";
export type StatusFilter = "incomplete" | "overdue";

export interface ReminderGroup {
  key: string;
  label: string;
  rows: OutstandingRow[];
}

const ALL_TASKS = "__all__";
export const ALL_ORGANIZERS = "__all__";
const NO_ORGANIZER = "— No organizer —";
const NO_OWNER = "— Unassigned —";
const NO_PIC = "— No PIC —";

// ── Pure helpers (exported for the unit test) ─────────────────────────────

/** The group bucket a row falls into for the chosen axis. */
export function groupLabel(row: OutstandingRow, by: GroupBy): string {
  if (by === "organizer") return row.organizer?.trim() || NO_ORGANIZER;
  if (by === "owner") return row.owner_name?.trim() || NO_OWNER;
  return row.pic_name?.trim() || NO_PIC;
}

/** Distinct task titles present in the data, alphabetically — feeds the Task dropdown. */
export function distinctTasks(rows: readonly OutstandingRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const t = r.title.trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct organizers present in the data, alphabetically — feeds the Organizer dropdown. */
export function distinctOrganizers(rows: readonly OutstandingRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const o = r.organizer?.trim();
    if (o) set.add(o);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface RowFilter {
  task: string;
  status: StatusFilter;
  organizer: string;
}

/** Narrow by selected task + status (overdue-only vs all incomplete) + organizer. */
export function filterRows(rows: readonly OutstandingRow[], f: RowFilter): OutstandingRow[] {
  return rows.filter((r) => {
    if (f.task !== ALL_TASKS && r.title !== f.task) return false;
    if (f.status === "overdue" && r.overdue_days <= 0) return false;
    if (f.organizer !== ALL_ORGANIZERS && (r.organizer?.trim() ?? "") !== f.organizer) return false;
    return true;
  });
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };

/**
 * "31 Oct – 2 Nov" / "2 Oct – 4 Oct" / "5 Oct" — the event dates as the owner
 * reads them on a card. Dates are calendar days (no time), so UTC keeps the day
 * stable whatever the browser's zone.
 */
export function dateRange(start: string | null, end: string | null): string {
  const s = start ? new Date(`${start.slice(0, 10)}T00:00:00Z`) : null;
  const e = end ? new Date(`${end.slice(0, 10)}T00:00:00Z`) : null;
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", DAY_MONTH);
  if (s && !Number.isNaN(s.getTime()) && e && !Number.isNaN(e.getTime())) {
    if (s.getTime() === e.getTime()) return fmt(s);
    return `${fmt(s)} – ${fmt(e)}`;
  }
  if (s && !Number.isNaN(s.getTime())) return fmt(s);
  return "";
}

/** Sort rows within a group: overdue first (most overdue first), then by due date, then title. */
function sortGroupRows(rows: OutstandingRow[]): OutstandingRow[] {
  return [...rows].sort((a, b) => {
    if (a.overdue_days !== b.overdue_days) return b.overdue_days - a.overdue_days;
    const ad = a.due_date ?? "9999-12-31";
    const bd = b.due_date ?? "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** Group + sort: biggest pile of pending work first, then alphabetical. */
export function groupRows(rows: readonly OutstandingRow[], by: GroupBy): ReminderGroup[] {
  const map = new Map<string, OutstandingRow[]>();
  for (const r of rows) {
    const label = groupLabel(r, by);
    const arr = map.get(label);
    if (arr) arr.push(r);
    else map.set(label, [r]);
  }
  return [...map.entries()]
    .map(([label, groupRowList]) => ({
      key: label,
      label,
      rows: sortGroupRows(groupRowList),
    }))
    .sort((a, b) => {
      if (a.rows.length !== b.rows.length) return b.rows.length - a.rows.length;
      return a.label.localeCompare(b.label);
    });
}

/** One row rendered as a WhatsApp line. */
function rowLine(r: OutstandingRow): string {
  const dot = r.overdue_days > 0 ? "🔴" : "🟡";
  const bits = [`${dot} ${r.title} — ${r.name}`];
  if (r.booth_no?.trim()) bits.push(`Booth ${r.booth_no.trim()}`);
  if (r.overdue_days > 0) bits.push(`overdue ${r.overdue_days}d`);
  else if (r.due_date) bits.push(`due ${r.due_date.slice(0, 10)}`);
  return bits.join(" · ");
}

/** One group's paste-ready block: bold name + count, then its sorted rows. */
export function buildGroupMessage(group: ReminderGroup): string {
  const head = `*${group.label}* (${group.rows.length})`;
  const lines = group.rows.map(rowLine);
  return [head, ...lines].join("\n");
}

/**
 * The whole compiled message: a header naming the filter, every group as a
 * labelled sub-section, and a total at the end.
 */
export function buildAllMessage(
  groups: readonly ReminderGroup[],
  ctx: { task: string; monthLabel: string; status: StatusFilter; organizer: string },
): string {
  const taskLabel = ctx.task === ALL_TASKS ? "All tasks" : ctx.task;
  const statusLabel = ctx.status === "overdue" ? "Overdue only" : "Incomplete";
  const parts = [taskLabel];
  if (ctx.organizer !== ALL_ORGANIZERS) parts.push(ctx.organizer);
  parts.push(ctx.monthLabel, statusLabel);
  const header = `📋 Outstanding — ${parts.join(" · ")}`;
  const blocks = groups.map(buildGroupMessage);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const footer = `Total: ${total} task${total === 1 ? "" : "s"} across ${groups.length} ${
    groups.length === 1 ? "group" : "groups"
  }`;
  return [header, "", ...intersperse(blocks), "", footer].join("\n");
}

/** Join blocks with a blank line between them. */
function intersperse(blocks: readonly string[]): string[] {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (i > 0) out.push("");
    out.push(b);
  });
  return out;
}

/** Current month (YYYY-MM) in Malaysia time — the sensible default. */
export function currentMonthMyt(now: number = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 7);
}

/** A short list of month options around now, newest first, plus "All". */
export function monthOptions(now: number = Date.now()): { value: string; label: string }[] {
  const base = new Date(now + 8 * 3_600_000);
  const opts: { value: string; label: string }[] = [];
  // From 9 months ahead down to 3 months back, so upcoming events lead.
  for (let offset = 9; offset >= -3; offset--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
    const value = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    opts.push({ value, label });
  }
  return opts;
}

// ── Component ─────────────────────────────────────────────────────────────

export default function OutstandingReminders() {
  const toast = useToast();
  const [month, setMonth] = useState<string>(() => currentMonthMyt());
  const [task, setTask] = useState<string>(ALL_TASKS);
  const [status, setStatus] = useState<StatusFilter>("incomplete");
  const [organizer, setOrganizer] = useState<string>(ALL_ORGANIZERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("organizer");

  const q = useQuery<OutstandingResponse>(
    "/api/projects/outstanding-tasks",
    (signal) =>
      api.get(`/api/projects/outstanding-tasks${buildQuery({ month: month || undefined })}`, { signal }),
    [month],
    { keepPreviousData: true },
  );

  const allRows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const tasks = useMemo(() => distinctTasks(allRows), [allRows]);
  const organizers = useMemo(() => distinctOrganizers(allRows), [allRows]);
  const filtered = useMemo(
    () => filterRows(allRows, { task, status, organizer }),
    [allRows, task, status, organizer],
  );
  const groups = useMemo(() => groupRows(filtered, groupBy), [filtered, groupBy]);

  const months = useMemo(() => monthOptions(), []);
  const monthLabel = month
    ? months.find((m) => m.value === month)?.label ?? month
    : "All months";
  const totalTasks = filtered.length;

  async function copyText(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${what} — paste into WhatsApp`);
    } catch {
      toast.error("Could not copy — your browser blocked clipboard access");
    }
  }

  // A specific task the current filter has narrowed to (or null when "All tasks"
  // is showing) — lets each group header say WHICH task is outstanding.
  const narrowedTask = task === ALL_TASKS ? null : task;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 shadow-stone">
        <FilterSelect
          label="Task"
          value={task}
          onChange={setTask}
          options={[{ value: ALL_TASKS, label: "All tasks" }, ...tasks.map((t) => ({ value: t, label: t }))]}
          highlight={narrowedTask !== null}
        />
        <FilterSelect
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={[
            { value: "incomplete", label: "Incomplete" },
            { value: "overdue", label: "Overdue only" },
          ]}
        />
        <FilterSelect
          label="Month"
          value={month}
          onChange={setMonth}
          options={[{ value: "", label: "All months" }, ...months]}
        />
        <FilterSelect
          label="Organizer"
          value={organizer}
          onChange={setOrganizer}
          options={[{ value: ALL_ORGANIZERS, label: "All" }, ...organizers.map((o) => ({ value: o, label: o }))]}
          highlight={organizer !== ALL_ORGANIZERS}
        />
        <FilterSelect
          label="Group by"
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          options={[
            { value: "organizer", label: "Organizer" },
            { value: "owner", label: "Owner" },
            { value: "pic", label: "Sales PIC" },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          {q.fetching && <span className="text-[11px] text-ink-muted">Loading…</span>}
          <button
            onClick={() =>
              void copyText(buildAllMessage(groups, { task, monthLabel, status, organizer }), "all groups")
            }
            disabled={groups.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[11px] font-semibold uppercase tracking-wider text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
            title="Copy the whole compiled reminder (all groups) to paste into one WhatsApp group"
          >
            <ClipboardList size={13} /> Copy all for group
          </button>
        </div>
      </div>

      {/* Results */}
      {q.error ? (
        <div className="rounded-xl border border-err/40 bg-err-bg p-6 text-center text-[12px] text-err">
          {q.error}
        </div>
      ) : q.loading && !q.data ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
          Loading outstanding tasks…
        </div>
      ) : totalTasks === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-[13px] text-ink-muted shadow-stone">
          🎉 Nothing outstanding for this filter.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-[11px] text-ink-muted">
            {totalTasks} outstanding task{totalTasks === 1 ? "" : "s"} · {groups.length}{" "}
            {groupBy === "organizer" ? "organizer" : groupBy === "owner" ? "owner" : "PIC"}
            {groups.length === 1 ? "" : "s"}
          </div>
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              groupBy={groupBy}
              narrowedTask={narrowedTask}
              onCopy={() => void copyText(buildGroupMessage(g), g.label)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  highlight,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
  highlight?: boolean;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border bg-surface px-2.5 py-1.5 text-[11px]",
        highlight ? "border-accent/60 bg-accent-soft/40" : "border-border",
      )}
    >
      <span className="font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[180px] cursor-pointer bg-transparent font-semibold text-ink outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const AXIS_LABEL: Record<GroupBy, string> = { organizer: "Organizer", owner: "Owner", pic: "Sales PIC" };

// Avatar tint cycles by first letter so the same person keeps the same colour
// across reloads — recognisable at a glance, no per-user config.
const AVATAR_TINTS = ["bg-primary", "bg-synced", "bg-accent", "bg-err", "bg-warning-text"];
function avatarTint(label: string): string {
  const code = label.trim().toUpperCase().charCodeAt(0) || 0;
  return AVATAR_TINTS[code % AVATAR_TINTS.length];
}

function GroupCard({
  group,
  groupBy,
  narrowedTask,
  onCopy,
}: {
  group: ReminderGroup;
  groupBy: GroupBy;
  narrowedTask: string | null;
  onCopy: () => void;
}) {
  const initial = group.label.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <div className="flex items-center justify-between gap-3 bg-ink px-4 py-2.5 text-white">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-[13px] font-bold text-white",
              avatarTint(group.label),
            )}
            aria-hidden
          >
            {initial}
          </span>
          <div className="min-w-0">
            <div className="truncate font-display text-[14px] font-bold">{group.label}</div>
            <div className="truncate text-[11px] text-white/60">
              {AXIS_LABEL[groupBy]} · {group.rows.length} pending
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {narrowedTask && (
            <span className="hidden text-[11px] text-white/60 sm:inline">{narrowedTask} not done</span>
          )}
          <button
            onClick={onCopy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/25 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-white/10"
            title={`Copy ${group.label}'s list only`}
          >
            <Copy size={12} /> Copy {group.label}
          </button>
        </div>
      </div>
      <div className="divide-y divide-border">
        {group.rows.map((r) => {
          const when = dateRange(r.start_date, r.end_date);
          const meta = [when, r.booth_no?.trim() ? `Booth ${r.booth_no.trim()}` : null]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] font-bold text-accent">{r.code}</div>
                <div className="truncate text-[13px] font-semibold text-ink">
                  {r.title}
                  {r.review_status === "pending_review" && (
                    <span className="ml-1.5 text-[11px] font-normal text-ink-muted">· in review</span>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-ink-muted">
                  {r.name}
                  {meta ? ` · ${meta}` : ""}
                </div>
              </div>
              <StatusBadge row={r} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusBadge({ row }: { row: OutstandingRow }) {
  if (row.overdue_days > 0) {
    return (
      <span className="shrink-0 rounded-full border border-err/30 bg-err-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-err">
        Overdue {row.overdue_days}d
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-warning-text/30 bg-warning-bg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning-text">
      Pending
    </span>
  );
}
