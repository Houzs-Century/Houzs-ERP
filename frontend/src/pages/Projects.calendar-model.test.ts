import { describe, expect, it } from "vitest";

import { buildCalendarWindow, buildProjectsCalendarModel } from "./Projects";

type CalendarModelInput = Parameters<typeof buildProjectsCalendarModel>[0];

function project(
  id: number,
  overrides: Partial<CalendarModelInput["allProjects"][number]> = {},
): CalendarModelInput["allProjects"][number] {
  return {
    id,
    code: `P-${id}`,
    name: `Project ${id}`,
    stage: "setup",
    status: "confirmed",
    brand: "Brand A",
    organizer: "Organizer A",
    start_date: "2026-03-02",
    end_date: "2026-03-02",
    venue: `Venue ${id}`,
    state: "KL",
    active_section_name: "Setup",
    sections_total: 2,
    ...overrides,
  };
}

function task(
  id: number,
  projectId: number,
): CalendarModelInput["allTasks"][number] {
  return {
    id,
    project_id: projectId,
    project_code: `P-${projectId}`,
    project_name: `Project ${projectId}`,
    brand: "Brand A",
    organizer: "Organizer A",
    title: `Task ${id}`,
    due_date: "2026-03-02",
    status: "pending",
    project_status: "confirmed",
    required_perm: null,
    review_status: null,
    owner_name: null,
    is_overdue: 0,
  };
}

describe("buildProjectsCalendarModel", () => {
  it("filters tasks through the project map and packs month lanes deterministically", () => {
    const cells = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 2, 2 + index));
      return { date, iso: date.toISOString().slice(0, 10) };
    });
    const allProjects = [
      project(1),
      project(2),
      project(3),
      project(4),
      project(5, { status: "pending" }),
    ];

    const model = buildProjectsCalendarModel({
      allProjects,
      allTasks: [task(11, 1), task(55, 5)],
      cells,
      weekCount: 1,
      mode: "month",
      anchorMonth: 2,
      brand: "",
      status: "confirmed",
      organizer: "",
      showTasks: true,
      expandAll: false,
    });

    expect(model.projectById.has(4)).toBe(true);
    expect(model.projectById.has(5)).toBe(false);
    expect(model.tasks.map(({ id }) => id)).toEqual([11]);
    expect(model.tasksByDate.get("2026-03-02")?.map(({ id }) => id)).toEqual([11]);
    expect(model.weekSegs[0].map(({ project: item, lane }) => [item.id, lane])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    expect(model.overflowByCell).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(model.barsAreaHByWeek).toEqual([63]);
    expect(model.cellBarsH).toEqual([63, 0, 0, 0, 0, 0, 0]);
    expect(model.renderedWeeks).toBe(1);
  });
});

describe("buildCalendarWindow", () => {
  it("builds a stable 42-day month window across leap day and month boundaries", () => {
    const window = buildCalendarWindow("month", "2024-02", "");

    expect(window.weekCount).toBe(6);
    expect(window.totalCells).toBe(42);
    expect(window.fromStr).toBe("2024-01-29");
    expect(window.toStr).toBe("2024-03-10");
    expect(window.cells).toHaveLength(42);
    expect(window.cells[0].iso).toBe("2024-01-29");
    expect(window.cells[31].iso).toBe("2024-02-29");
    expect(window.cells[41].iso).toBe("2024-03-10");
    expect(new Set(window.cells.map(({ iso }) => iso))).toHaveLength(42);
    expect(window.cells.every(({ date, iso }) => date.toISOString() === `${iso}T00:00:00.000Z`)).toBe(true);
  });

  it("starts a Sunday-first month on the prior Monday without dropping boundary days", () => {
    const window = buildCalendarWindow("month", "2026-03", "");

    expect(window.fromStr).toBe("2026-02-23");
    expect(window.toStr).toBe("2026-04-05");
    expect(window.cells.map(({ iso }) => iso)).toContain("2026-03-01");
    expect(window.cells.map(({ iso }) => iso)).toContain("2026-03-31");
  });

  it("normalizes a week anchor to Monday across year and leap-month boundaries", () => {
    const yearBoundary = buildCalendarWindow("week", "", "2026-01-01");
    expect(yearBoundary.fromStr).toBe("2025-12-29");
    expect(yearBoundary.toStr).toBe("2026-01-04");
    expect(yearBoundary.cells.map(({ iso }) => iso)).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);

    const leapBoundary = buildCalendarWindow("week", "", "2024-03-01");
    expect(leapBoundary.fromStr).toBe("2024-02-26");
    expect(leapBoundary.toStr).toBe("2024-03-03");
    expect(leapBoundary.cells[3].iso).toBe("2024-02-29");
  });
});
