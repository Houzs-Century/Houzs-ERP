import { useMemo } from "react";
import { formatDate } from "../lib/utils";
import { getHolidaysOn } from "../lib/holidays";

/* ------------------------------------------------------------------ *
 * Mobile PMS Gantt (timeline) — a phone port of desktop ProjectGantt.
 *
 * Same layout MATH as the desktop component: a Monday-anchored week axis
 * auto-ranged from the project start/end (and any task due_date) padded
 * one week each side, one swim-lane per checklist section, a diamond per
 * task on its due_date coloured by status, Malaysia holiday bands and a
 * today line. Rendered onto the approved .hz-m mockup markup (.seg /
 * .gantt / .glane / .gtrack / .gcell / .dia / .today), so what shipped
 * matches the sign-off. No backend — the data is already in the PMS
 * payload MobilePMS loads.
 * ------------------------------------------------------------------ */

// Structural subsets — MobilePMS passes its own checklist/section rows.
export interface GanttSection {
  id: number;
  name: string;
  sort_order: number;
}
export interface GanttSectionProgress {
  id: number;
  total: number;
  done: number;
  na: number;
}
export interface GanttTask {
  id: number;
  title: string;
  status: string | null; // pending | done | na | blocked | review | ...
  due_date: string | null;
  section_id: number | null;
  required_perm?: string | null;
}

interface Props {
  projectStart: string | null;
  projectEnd: string | null;
  sections: GanttSection[];
  sectionProgress: GanttSectionProgress[];
  tasks: GanttTask[];
  onTaskClick: (taskId: number) => void;
}

const DAY_MS = 86_400_000;
const UNCAT_LANE_ID = -1;

// Status -> diamond colour. Verbatim from the approved mockup legend, all
// .hz-m tokens: pending amber, overdue red, done green, N/A mut, blocked ink.
const COL_PENDING = "#8a6a2e"; // --amber
const COL_OVERDUE = "#b23a3a"; // --red
const COL_DONE = "#2f8a5b"; // --green
const COL_NA = "#9aa093"; // --mut2
const COL_BLOCKED = "#11140f"; // --ink

function isoOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function startOfWeek(d: Date): Date {
  // Monday-anchored weeks (matches desktop ProjectGantt + PnlCalendar).
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

export function MobileGantt({
  projectStart,
  projectEnd,
  sections,
  sectionProgress,
  tasks,
  onTaskClick,
}: Props) {
  const today = isoOnly(new Date());

  // ── Timeline range ─────────────────────────────────────────
  // Anchor to project dates, extend to cover any out-of-range task due_date,
  // then snap to Monday weeks padded one week on each side.
  const range = useMemo(() => {
    const anchors: number[] = [];
    if (projectStart) anchors.push(new Date(projectStart).getTime());
    if (projectEnd) anchors.push(new Date(projectEnd).getTime());
    for (const t of tasks) if (t.due_date) anchors.push(new Date(t.due_date).getTime());
    if (anchors.length === 0) {
      const now = new Date();
      anchors.push(addDays(now, -14).getTime(), addDays(now, 14).getTime());
    }
    const start = startOfWeek(addDays(new Date(Math.min(...anchors)), -7));
    const end = addDays(startOfWeek(addDays(new Date(Math.max(...anchors)), 7)), 6);
    const totalDays = diffDays(start, end) + 1;
    const totalWeeks = Math.ceil(totalDays / 7);
    return { start, end, totalDays, totalWeeks };
  }, [projectStart, projectEnd, tasks]);

  // Week header labels — short numeric D/M (desktop parity, numeric-only rule).
  const weeks = useMemo(() => {
    const out: { label: string; hol: boolean }[] = [];
    for (let w = 0; w < range.totalWeeks; w++) {
      const day = addDays(range.start, w * 7);
      let hol = false;
      for (let i = 0; i < 7; i++) {
        if (getHolidaysOn(isoOnly(addDays(day, i))).length > 0) { hol = true; break; }
      }
      out.push({ label: `${day.getUTCDate()}/${day.getUTCMonth() + 1}`, hol });
    }
    return out;
  }, [range]);

  // ── Group tasks per lane ───────────────────────────────────
  const lanes = useMemo(() => {
    const out: Array<{ id: number; name: string; tasks: GanttTask[]; prog?: GanttSectionProgress }> = [];
    const ordered = [...sections].sort((a, b) => a.sort_order - b.sort_order);
    for (const s of ordered) {
      out.push({
        id: s.id,
        name: s.name,
        tasks: tasks.filter((t) => t.section_id === s.id),
        prog: sectionProgress.find((p) => p.id === s.id),
      });
    }
    const uncat = tasks.filter((t) => t.section_id == null);
    if (uncat.length > 0) out.push({ id: UNCAT_LANE_ID, name: "Uncategorised", tasks: uncat });
    return out;
  }, [sections, sectionProgress, tasks]);

  if (tasks.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#9aa093", padding: "20px 2px" }}>
        No tasks scheduled yet. Add tasks in the List view to populate the timeline.
      </div>
    );
  }

  // Position of a due_date as a percentage across the whole track (day-centred).
  const leftPct = (iso: string): number => {
    const d = diffDays(range.start, new Date(iso));
    return ((d + 0.5) / range.totalDays) * 100;
  };

  const todayDate = new Date(today);
  const todayInRange = todayDate >= range.start && todayDate <= range.end;

  // Each week wants a readable min column; 68px echoes the mockup (520 / ~6).
  const gridCols = `112px repeat(${range.totalWeeks}, 1fr)`;
  const trackCols = `repeat(${range.totalWeeks}, 1fr)`;
  const minWidth = 112 + range.totalWeeks * 68;

  return (
    <>
      <div className="legend">
        <span><i className="lgd" style={{ background: COL_PENDING }} />Pending</span>
        <span><i className="lgd" style={{ background: COL_OVERDUE }} />Overdue</span>
        <span><i className="lgd" style={{ background: COL_DONE }} />Done</span>
        <span><i className="lgd" style={{ background: COL_NA }} />N/A</span>
        <span><i className="lgd" style={{ background: COL_BLOCKED }} />Blocked</span>
      </div>

      <div className="gantt"><div className="gscroll"><div className="grid" style={{ minWidth }}>
        <div className="gaxis" style={{ gridTemplateColumns: gridCols }}>
          <div>Section</div>
          {weeks.map((w, i) => <div key={i}>{w.label}</div>)}
        </div>

        {lanes.map((lane) => {
          const done = lane.prog?.done ?? 0;
          const total = lane.prog?.total ?? lane.tasks.length;
          return (
            <div key={lane.id} className="glane" style={{ gridTemplateColumns: gridCols }}>
              <div className="lbl">
                <div className="nm">{lane.name}</div>
                <div className="pr">{done} / {total} done</div>
              </div>
              <div className="gtrack" style={{ gridTemplateColumns: trackCols }}>
                {weeks.map((w, i) => (
                  <div key={i} className={w.hol ? "gcell hol" : "gcell"} />
                ))}
                {todayInRange && <div className="today" style={{ left: `${leftPct(today)}%` }} />}
                {lane.tasks.map((task) => {
                  if (!task.due_date) return null; // no due date -> no placement
                  const status = (task.status ?? "").toLowerCase();
                  const overdue = status === "pending" && task.due_date < today;
                  const color = overdue
                    ? COL_OVERDUE
                    : status === "done"
                      ? COL_DONE
                      : status === "na"
                        ? COL_NA
                        : status === "blocked"
                          ? COL_BLOCKED
                          : COL_PENDING;
                  const gated = !!task.required_perm;
                  return (
                    <div
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      className={gated ? "dia lock" : "dia"}
                      style={{ left: `${leftPct(task.due_date)}%`, background: color, cursor: "pointer" }}
                      title={`${task.title} — ${formatDate(task.due_date)}${gated ? " · gated" : ""}`}
                      onClick={() => onTaskClick(task.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onTaskClick(task.id); } }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div></div></div>

      <div style={{ fontSize: 11.5, color: "#767b6e", lineHeight: 1.5, padding: "8px 2px 0" }}>
        Diamonds sit on each task's due date, coloured by status; the lock badge marks a permission-gated task. Hatched columns are Malaysia holidays. Tap a diamond to open that task in the checklist.
      </div>
    </>
  );
}
