import { useMemo } from "react";
import { CheckCircle2, Lock } from "lucide-react";
import { cn, formatDate } from "../lib/utils";
import { getHolidaysOn } from "../lib/holidays";

/**
 * Per-project Gantt — milestone view (mig 050 + companion to the
 * stage chip progress bar). One swim lane per tasklist section,
 * calendar weeks horizontally, a diamond per task on its `due_date`.
 *
 * Bars (start → end durations) are intentionally out of scope: the
 * schema only tracks `due_date`, not `start_date`, on tasks today.
 * When that lands (planned mig 051) this component swaps diamonds
 * for proper bars — the layout already accounts for the room.
 */

export interface GanttSection {
  id: number;
  name: string;
  sort_order: number;
}

export interface GanttSectionProgress {
  id: number;
  name: string;
  total: number;
  done: number;
  na: number;
  complete: number;
}

export interface GanttTask {
  id: number;
  title: string;
  status: "pending" | "done" | "na" | "blocked";
  due_date: string | null;
  section_id: number | null;
  required_perm: string | null;
  owner_name: string | null;
}

interface Props {
  projectStartDate: string | null;
  projectEndDate: string | null;
  sections: GanttSection[];
  sectionProgress: GanttSectionProgress[];
  tasks: GanttTask[];
  /** Click handler — flips back to the list view + scrolls the row in. */
  onTaskClick?: (taskId: number) => void;
}

const DAY_MS = 86_400_000;
const UNCAT_LANE_ID = -1;

function isoOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d: Date): Date {
  // Monday-anchored weeks (matches PnlCalendar elsewhere).
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export function ProjectGantt({
  projectStartDate,
  projectEndDate,
  sections,
  sectionProgress,
  tasks,
  onTaskClick,
}: Props) {
  // ── Compute timeline range ─────────────────────────────────
  // Anchor to project dates, but extend ±1 week if any task's
  // due_date falls outside so it stays visible (off-plan column gets
  // a muted background).
  const range = useMemo(() => {
    const anchors: number[] = [];
    if (projectStartDate) anchors.push(new Date(projectStartDate).getTime());
    if (projectEndDate) anchors.push(new Date(projectEndDate).getTime());
    for (const t of tasks) {
      if (t.due_date) anchors.push(new Date(t.due_date).getTime());
    }
    if (anchors.length === 0) {
      // Default to ±2 weeks around today.
      const today = new Date();
      anchors.push(addDays(today, -14).getTime(), addDays(today, 14).getTime());
    }
    const min = Math.min(...anchors);
    const max = Math.max(...anchors);
    // Snap to Monday weeks, padded one week on each side.
    const start = startOfWeek(addDays(new Date(min), -7));
    const end = addDays(startOfWeek(addDays(new Date(max), 7)), 6);
    const totalDays = diffDays(start, end) + 1;
    const totalWeeks = Math.ceil(totalDays / 7);
    return { start, end, totalDays, totalWeeks };
  }, [projectStartDate, projectEndDate, tasks]);

  const planStart = projectStartDate ? new Date(projectStartDate) : null;
  const planEnd = projectEndDate ? new Date(projectEndDate) : null;
  const today = isoOnly(new Date());
  const todayDate = new Date(today);

  // ── Group tasks per lane ───────────────────────────────────
  const lanes = useMemo(() => {
    const out: Array<{
      id: number;
      name: string;
      tasks: GanttTask[];
      progress?: GanttSectionProgress;
    }> = [];
    for (const s of sections) {
      out.push({
        id: s.id,
        name: s.name,
        tasks: tasks.filter((t) => t.section_id === s.id),
        progress: sectionProgress.find((p) => p.id === s.id),
      });
    }
    const uncat = tasks.filter((t) => t.section_id == null);
    if (uncat.length > 0 || sections.length === 0) {
      out.push({
        id: UNCAT_LANE_ID,
        name: "Uncategorised",
        tasks: uncat,
        progress: sectionProgress.find((p) => p.id === 0),
      });
    }
    return out;
  }, [sections, sectionProgress, tasks]);

  // Pre-compute week labels.
  const weeks = useMemo(() => {
    const out: { label: string; offsetDays: number }[] = [];
    for (let w = 0; w < range.totalWeeks; w++) {
      const day = addDays(range.start, w * 7);
      out.push({
        label: `${day.getUTCDate()}/${day.getUTCMonth() + 1}`,
        offsetDays: w * 7,
      });
    }
    return out;
  }, [range]);

  // Holiday bands depend only on the date range, not on any lane — so compute
  // the holiday-day list ONCE here instead of re-scanning every day for every
  // lane in the render below (was O(lanes × days): ~3,650 getHolidaysOn calls
  // for a 1-year × 10-lane chart, every render).
  const holidayBands = useMemo(() => {
    const out: { i: number; title: string }[] = [];
    for (let i = 0; i < range.totalDays; i++) {
      const hols = getHolidaysOn(isoOnly(addDays(range.start, i)));
      if (hols.length > 0) out.push({ i, title: hols.map((h) => h.name).join(", ") });
    }
    return out;
  }, [range]);

  // ALL HOOKS ABOVE THIS LINE. These two useMemos sat below the empty states
  // until 2026-08-17, so a chart that rendered "no tasks yet" first and then
  // gained a task called two more hooks on the second render than the first —
  // React error #310. `range` is memoised above and never depends on either
  // guard, so hoisting them changes nothing about what they compute.
  //
  // Empty states
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-bg/40 px-4 py-8 text-center text-[12px] text-ink-muted">
        No tasks scheduled yet. Add tasks in the List view to populate the
        Gantt.
      </div>
    );
  }
  if (!projectStartDate || !projectEndDate) {
    return (
      <div className="rounded-md border border-dashed border-warning-text/40 bg-warning-bg/40 px-4 py-6 text-[12px] text-warning-text">
        Set the project start and end dates to anchor the Gantt timeline.
        Without them, the chart auto-extends to whatever range your tasks
        span — useful, but harder to read.
      </div>
    );
  }

  // ── Helpers for column / position math ─────────────────────
  const dayWidth = 24; // px
  const chartWidth = range.totalDays * dayWidth;

  function leftFor(iso: string): number {
    const days = diffDays(range.start, new Date(iso));
    return days * dayWidth + dayWidth / 2;
  }

  function isOffPlan(iso: string): boolean {
    if (!planStart || !planEnd) return false;
    const d = new Date(iso);
    return d < planStart || d > planEnd;
  }

  function isOverdue(t: GanttTask): boolean {
    if (!t.due_date || t.status !== "pending") return false;
    return t.due_date < today;
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="rounded-md border border-border bg-surface">
      {/* Header bar — labels which range we're rendering. */}
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2 text-[11px] text-ink-muted">
        <span>
          <span className="font-mono text-ink">
            {formatDate(isoOnly(range.start))}
          </span>
          <span className="mx-1">→</span>
          <span className="font-mono text-ink">
            {formatDate(isoOnly(range.end))}
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase tracking-brand">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} · {lanes.length} lane{lanes.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="thin-scroll overflow-x-auto">
        {/* Row layout: a fixed-width lane label column on the left,
            then the chart canvas. We use grid-template-columns so
            the lane labels stay aligned across header + body. */}
        <div
          className="grid"
          style={{ gridTemplateColumns: `140px ${chartWidth}px` }}
        >
          {/* Week label row */}
          <div className="border-b border-border-subtle bg-bg/40" />
          <div
            className="relative border-b border-border-subtle bg-bg/40"
            style={{ height: 28 }}
          >
            {weeks.map((w, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 flex items-center border-l border-border-subtle pl-1.5 font-mono text-[9.5px] uppercase tracking-brand text-ink-muted"
                style={{ left: w.offsetDays * dayWidth, width: dayWidth * 7 }}
              >
                {w.label}
              </div>
            ))}
          </div>

          {/* Lane rows */}
          {lanes.map((lane) => {
            const denom = lane.progress
              ? lane.progress.total - lane.progress.na
              : 0;
            const done = lane.progress?.done ?? 0;
            const tint =
              denom === 0
                ? ""
                : done === 0
                ? ""
                : done === denom
                ? "bg-synced/10"
                : "bg-accent-soft/20";

            // Section "track" — hairline from earliest to latest task
            // due_date in this lane (only when the lane has 2+ tasks).
            const dated = lane.tasks
              .filter((t) => t.due_date)
              .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
            const trackStart = dated.length > 1 ? dated[0].due_date! : null;
            const trackEnd =
              dated.length > 1 ? dated[dated.length - 1].due_date! : null;

            return [
              // Lane label
              <div
                key={`label-${lane.id}`}
                className={cn(
                  "flex items-center border-b border-border-subtle px-3 text-[11px] font-semibold tracking-wider text-ink-secondary",
                  tint
                )}
                style={{ minHeight: 36 }}
              >
                <span className="truncate">{lane.name}</span>
                {lane.progress && (
                  <span className="ml-auto font-mono text-[10px] text-ink-muted">
                    {done}/{denom || 0}
                  </span>
                )}
              </div>,
              // Lane chart row
              <div
                key={`row-${lane.id}`}
                className={cn(
                  "relative border-b border-border-subtle",
                  tint
                )}
                style={{ minHeight: 36 }}
              >
                {/* Off-plan shading — bands left of planStart and
                    right of planEnd. Helps admins see at a glance
                    which tasks are off-schedule. */}
                {planStart && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0 bg-bg/40"
                    style={{
                      width: Math.max(
                        0,
                        diffDays(range.start, planStart) * dayWidth
                      ),
                    }}
                  />
                )}
                {planEnd && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 right-0 bg-bg/40"
                    style={{
                      width: Math.max(
                        0,
                        diffDays(planEnd, range.end) * dayWidth
                      ),
                    }}
                  />
                )}

                {/* Holiday bands — share PnlCalendar's getHolidaysOn so
                    the Gantt inherits the same calendar awareness
                    without parallel data. */}
                {holidayBands.map(({ i, title }) => (
                  <div
                    key={`hol-${i}`}
                    aria-hidden
                    title={title}
                    className="pointer-events-none absolute inset-y-0 bg-err/5"
                    style={{ left: i * dayWidth, width: dayWidth }}
                  />
                ))}

                {/* Per-section track (hairline). */}
                {trackStart && trackEnd && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 h-px -translate-y-1/2 bg-border-strong/40"
                    style={{
                      left: leftFor(trackStart),
                      width: leftFor(trackEnd) - leftFor(trackStart),
                    }}
                  />
                )}

                {/* Today marker. */}
                {todayDate >= range.start && todayDate <= range.end && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 border-l border-dashed border-accent"
                    style={{ left: leftFor(today) }}
                  />
                )}

                {/* Diamonds. */}
                {lane.tasks.map((task) => {
                  if (!task.due_date) {
                    // No due date — render a faint floating chip on the
                    // far left so the task isn't invisible.
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onTaskClick?.(task.id)}
                        title={`${task.title} — no due date set`}
                        className="absolute top-1/2 -translate-y-1/2 rounded-full border border-dashed border-border bg-surface px-2 py-0.5 font-mono text-[9px] uppercase tracking-brand text-ink-muted hover:border-accent/40 hover:text-accent"
                        style={{ left: 4 }}
                      >
                        ?
                      </button>
                    );
                  }
                  const left = leftFor(task.due_date);
                  const overdue = isOverdue(task);
                  const offPlan = isOffPlan(task.due_date);
                  const status = task.status;
                  const gated = !!task.required_perm;

                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onTaskClick?.(task.id)}
                      title={[
                        task.title,
                        `Due ${formatDate(task.due_date)}`,
                        task.owner_name ? `Owner: ${task.owner_name}` : null,
                        gated ? `Gated: ${task.required_perm}` : null,
                        offPlan ? "Off-plan" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      className={cn(
                        "group absolute top-1/2 grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rotate-45 rounded-sm border-2 transition-all",
                        // Status colour
                        status === "done" &&
                          "border-synced bg-synced text-white",
                        status === "na" &&
                          "border-ink-muted bg-bg opacity-50",
                        status === "blocked" &&
                          "border-amber-500 bg-amber-100",
                        status === "pending" &&
                          !overdue &&
                          "border-accent bg-surface",
                        status === "pending" &&
                          overdue &&
                          "animate-pulse border-err bg-err text-white",
                        // Hover lift
                        "hover:scale-110 hover:shadow-stone"
                      )}
                      style={{ left }}
                    >
                      {status === "done" && (
                        <CheckCircle2
                          size={10}
                          className="-rotate-45 text-white"
                        />
                      )}
                      {gated && (
                        <span
                          aria-hidden
                          className="absolute -right-1 -top-1 grid h-3 w-3 -rotate-45 place-items-center rounded-full bg-accent text-white shadow-stone"
                        >
                          <Lock size={7} strokeWidth={2.4} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>,
            ];
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle bg-bg/40 px-3 py-2 text-[10px] text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-sm border border-accent bg-surface" />
          Pending
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-sm border border-err bg-err" />
          Overdue
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-sm border border-synced bg-synced" />
          Done
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rotate-45 rounded-sm border border-amber-500 bg-amber-100" />
          Blocked
        </span>
        <span className="inline-flex items-center gap-1">
          <Lock size={8} className="text-accent" />
          Gated
        </span>
        <span className="ml-auto inline-flex items-center gap-1 font-mono uppercase tracking-brand">
          <span className="inline-block h-3 w-px border-l border-dashed border-accent" />
          Today
        </span>
      </div>
    </div>
  );
}
