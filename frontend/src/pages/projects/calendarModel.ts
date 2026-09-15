import { compareCalendarEvents } from "../../lib/calendarSort";
import type { ProjectStage, ProjectStatus } from "./types";

export interface CalendarProject {
  id: number;
  code: string;
  name: string;
  stage: ProjectStage;
  status: ProjectStatus;
  brand: string | null;
  organizer: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  // Section-driven stage (mig 050). Mirrors the list endpoint's
  // active_section_name + sections_total.
  active_section_name?: string | null;
  sections_total?: number;
  // Calendar masks the title to the composed default name for solo
  // event types (backend returns event_type_name on the calendar feed).
  event_type_name?: string | null;
}

export interface CalendarTask {
  id: number;
  project_id: number;
  project_code: string;
  project_name: string;
  brand: string | null;
  organizer: string | null;
  title: string;
  due_date: string;
  status: string;
  /** Parent project's status — drives the calendar tint. */
  project_status: ProjectStatus | null;
  required_perm: string | null;
  review_status: string | null;
  owner_name: string | null;
  is_overdue: number;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export type CalendarMode = "month" | "week";
type CalendarCell = { date: Date; iso: string };
type CalendarWeekSeg = {
  project: CalendarProject;
  startCol: number;
  endCol: number;
  clipLeft: boolean;
  clipRight: boolean;
  lane: number;
};

export const CALENDAR_BAR_H = 18;
const CALENDAR_LANE_GAP = 3;
export const CALENDAR_LANE_TOTAL = CALENDAR_BAR_H + CALENDAR_LANE_GAP;
export const EMPTY_CALENDAR_PROJECTS: CalendarProject[] = [];
export const EMPTY_CALENDAR_TASKS: CalendarTask[] = [];

export function buildCalendarWindow(
  mode: CalendarMode,
  monthStr: string,
  weekStartStr: string,
): {
  anchor: Date;
  startDay: Date;
  endDay: Date;
  cells: CalendarCell[];
  weekCount: number;
  totalCells: number;
  fromStr: string;
  toStr: string;
} {
  let monthAnchor: Date;
  if (/^\d{4}-\d{2}$/.test(monthStr)) {
    monthAnchor = new Date(Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)) - 1, 1);
  } else {
    monthAnchor = new Date();
    monthAnchor.setDate(1);
  }

  let weekAnchor: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
    weekAnchor = new Date(weekStartStr + "T00:00:00Z");
  } else {
    weekAnchor = new Date();
    weekAnchor.setUTCHours(0, 0, 0, 0);
  }
  weekAnchor.setUTCDate(weekAnchor.getUTCDate() - ((weekAnchor.getUTCDay() + 6) % 7));

  const anchor = mode === "week" ? weekAnchor : monthAnchor;
  const weekCount = mode === "week" ? 1 : 6;
  const totalCells = weekCount * 7;
  let startDay: Date;
  if (mode === "week") {
    startDay = new Date(anchor);
  } else {
    const first = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), 1));
    startDay = new Date(first);
    startDay.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  }
  const endDay = new Date(startDay);
  endDay.setUTCDate(startDay.getUTCDate() + totalCells - 1);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const date = new Date(startDay);
    date.setUTCDate(startDay.getUTCDate() + i);
    cells.push({ date, iso: date.toISOString().slice(0, 10) });
  }
  return {
    anchor,
    startDay,
    endDay,
    cells,
    weekCount,
    totalCells,
    fromStr: startDay.toISOString().slice(0, 10),
    toStr: endDay.toISOString().slice(0, 10),
  };
}

/**
 * Pure calendar projection. Keeping this outside React makes hover/popover and
 * viewport-height renders O(1) with respect to project/task count: React only
 * rebuilds the model when its actual data/filter/window inputs change.
 */
export function buildProjectsCalendarModel({
  allProjects,
  allTasks,
  cells,
  weekCount,
  mode,
  anchorMonth,
  brand,
  status,
  organizer,
  q = "",
  showTasks,
  expandAll,
}: {
  allProjects: CalendarProject[];
  allTasks: CalendarTask[];
  cells: CalendarCell[];
  weekCount: number;
  mode: CalendarMode;
  anchorMonth: number;
  brand: string;
  status: string;
  organizer: string;
  /** Free-text search — matches venue/organizer/brand/project code/name/event
   *  type. Empty string = no filter. Defaults to "" so callers pre-dating the
   *  search box (tests) still pass. */
  q?: string;
  showTasks: boolean;
  expandAll: boolean;
}) {
  // Filter by project STATUS (owner 2026-07-28) — the calendar's old "section"
  // dropdown is now confirmed / pending / cancelled.
  const matchesStatus = (project: CalendarProject): boolean =>
    !status || ((project.status as string | null) || "").toLowerCase() === status;

  // Free-text search — case-insensitive over the visible/label fields.
  const needle = q.trim().toLowerCase();
  const matchesQuery = (project: CalendarProject): boolean => {
    if (!needle) return true;
    const hay = [
      project.code,
      project.name,
      project.venue ?? "",
      project.organizer ?? "",
      project.brand ?? "",
      project.state ?? "",
      project.event_type_name ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  };

  const projects = allProjects.filter((project) => {
    if (brand && project.brand !== brand) return false;
    if (!matchesStatus(project)) return false;
    if (organizer && (project.organizer || "") !== organizer) return false;
    if (!matchesQuery(project)) return false;
    return true;
  });
  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const tasks = showTasks
    ? allTasks.filter((task) => {
        if (brand && task.brand !== brand) return false;
        if (organizer && (task.organizer || "") !== organizer) return false;
        // With a search: only render tasks whose parent project passed the
        // filter — keeps the view consistent (task chips beside their bar).
        if (needle && !projectById.has(task.project_id)) return false;
        return !status || projectById.has(task.project_id);
      })
    : [];

  const tasksByDate = new Map<string, CalendarTask[]>();
  for (const task of tasks) {
    const key = ((task.due_date as string | null) ?? "").slice(0, 10);
    if (!key) continue;
    const sameDay = tasksByDate.get(key);
    if (sameDay) sameDay.push(task);
    else tasksByDate.set(key, [task]);
  }

  const totalCells = cells.length;
  const maxLanes = mode === "week" || expandAll ? Infinity : 3;
  const weekSegs: CalendarWeekSeg[][] = Array.from({ length: weekCount }, () => []);
  const overflowByCell: number[] = Array(totalCells).fill(0);
  let renderedWeeks = 0;

  for (let week = 0; week < weekCount; week++) {
    const weekCells = cells.slice(week * 7, week * 7 + 7);
    if (mode !== "month" || weekCells.some((cell) => cell.date.getUTCMonth() === anchorMonth)) {
      renderedWeeks += 1;
    }
    const weekStart = weekCells[0].iso;
    const weekEnd = weekCells[6].iso;
    let monthFirstCol = 0;
    let monthLastCol = 6;
    if (mode === "month") {
      monthFirstCol = -1;
      for (let day = 0; day < 7; day++) {
        if (weekCells[day].date.getUTCMonth() === anchorMonth) {
          if (monthFirstCol === -1) monthFirstCol = day;
          monthLastCol = day;
        }
      }
    }

    const segments: CalendarWeekSeg[] = [];
    if (mode !== "month" || monthFirstCol !== -1) {
      for (const project of projects) {
        const start = project.start_date.slice(0, 10);
        const end = (project.end_date || project.start_date).slice(0, 10);
        if (end < weekStart || start > weekEnd) continue;
        const clipLeft = start < weekStart;
        const clipRight = end > weekEnd;
        let startCol = clipLeft ? 0 : daysBetween(weekStart, start);
        let endCol = clipRight ? 6 : daysBetween(weekStart, end);
        if (mode === "month") {
          if (endCol < monthFirstCol || startCol > monthLastCol) continue;
          startCol = Math.max(startCol, monthFirstCol);
          endCol = Math.min(endCol, monthLastCol);
        }
        segments.push({ project, startCol, endCol, clipLeft, clipRight, lane: 0 });
      }
    }

    segments.sort(
      (a, b) =>
        compareCalendarEvents(a.project, b.project) ||
        a.startCol - b.startCol ||
        b.endCol - b.startCol - (a.endCol - a.startCol),
    );
    const lanes: CalendarWeekSeg[][] = [];
    for (const segment of segments) {
      let lane = lanes.findIndex((items) =>
        items.every((item) => item.endCol < segment.startCol || item.startCol > segment.endCol),
      );
      if (lane === -1) {
        lanes.push([segment]);
        lane = lanes.length - 1;
      } else {
        lanes[lane].push(segment);
      }
      segment.lane = lane;
    }
    for (const segment of segments) {
      if (segment.lane < maxLanes) {
        weekSegs[week].push(segment);
      } else {
        for (let day = segment.startCol; day <= segment.endCol; day++) {
          overflowByCell[week * 7 + day] += 1;
        }
      }
    }
  }

  const barsAreaHByWeek = weekSegs.map((segments) => {
    const lanesUsed = segments.reduce((max, segment) => Math.max(max, segment.lane + 1), 0);
    return mode === "week" || expandAll
      ? Math.max(lanesUsed, 1) * CALENDAR_LANE_TOTAL
      : 3 * CALENDAR_LANE_TOTAL;
  });
  const cellBarsH = Array(totalCells).fill(0);
  for (let week = 0; week < weekCount; week++) {
    for (const segment of weekSegs[week]) {
      for (let col = segment.startCol; col <= segment.endCol; col++) {
        const index = week * 7 + col;
        cellBarsH[index] = Math.max(cellBarsH[index], (segment.lane + 1) * CALENDAR_LANE_TOTAL);
      }
    }
  }

  return {
    projects,
    projectById,
    tasks,
    tasksByDate,
    weekSegs,
    overflowByCell,
    barsAreaHByWeek,
    cellBarsH,
    renderedWeeks,
  };
}
