/* Calendar cell and overlay pieces: the task chip, the per-day count badge, the
 * bar hover card and the "+N more" day modal. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CalendarProject, CalendarTask } from "./calendarModel";
import type { ProjectStatus } from "./types";
import { CalendarBarPopover, CalendarDayModal, CalendarTaskChip, DayCountBadge } from "./calendarParts";

const PROJECT: CalendarProject = {
  id: 7,
  code: "HZ-007",
  name: "Selangor [HOUZS] SOLO @ MITEC",
  stage: "setup",
  status: "confirmed",
  brand: "HOUZS",
  organizer: "Organizer Sdn Bhd",
  start_date: "2026-08-01",
  end_date: "2026-08-03",
  venue: "MITEC",
  state: "Selangor",
};

function task(over: Partial<CalendarTask>): CalendarTask {
  return {
    id: 1,
    project_id: 7,
    project_code: "HZ-007",
    project_name: "Selangor [HOUZS] SOLO @ MITEC",
    brand: "HOUZS",
    organizer: null,
    title: "Setup Image",
    due_date: "2026-08-01",
    status: "pending",
    project_status: "confirmed",
    required_perm: null,
    review_status: null,
    owner_name: "Siti Aminah",
    is_overdue: 0,
    ...over,
  };
}

describe("CalendarTaskChip", () => {
  it("shows the title and the owner's initials, and opens on click", () => {
    const onOpen = vi.fn();
    render(<CalendarTaskChip task={task({})} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Setup Image")).toBeTruthy();
    expect(screen.getByText("SA")).toBeTruthy();
  });

  it("marks an unassigned task, and tints a status the palette does not hold as pending", () => {
    render(<CalendarTaskChip task={task({ owner_name: null, project_status: "active" as string as ProjectStatus })} onOpen={() => {}} />);
    expect(screen.getByTitle("Unassigned")).toBeTruthy();
    const dot = screen.getByRole("button").querySelector("span") as HTMLSpanElement;
    expect(dot.style.background).toBe("rgb(194, 116, 15)");
  });
});

describe("DayCountBadge", () => {
  it("says when the day includes overdue tasks", () => {
    render(<DayCountBadge count={3} overdue />);
    expect(screen.getByTitle("3 task(s) due — includes overdue").textContent).toBe("3");
  });
});

describe("CalendarBarPopover", () => {
  it("renders the project card with its state upcased and its date span", () => {
    render(<CalendarBarPopover info={{ project: PROJECT, x: 10, y: 10 }} />);
    expect(screen.getByText("HZ-007")).toBeTruthy();
    expect(screen.getByText("SELANGOR [HOUZS] SOLO @ MITEC")).toBeTruthy();
    expect(screen.getByText("01/08/2026 – 03/08/2026")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
  });
});

describe("CalendarDayModal", () => {
  it("lists the day's holiday, projects and tasks grouped by project, and closes on Escape", () => {
    const onClose = vi.fn();
    const onOpenProject = vi.fn();
    render(
      <CalendarDayModal
        iso="2026-08-01"
        projects={[PROJECT]}
        tasks={[task({}), task({ id: 2, title: "Driver Info", owner_name: null, is_overdue: 1 })]}
        holidays={[{ name: "Hari Kebangsaan" }]}
        onClose={onClose}
        onOpenProject={onOpenProject}
      />,
    );
    expect(screen.getByRole("heading", { name: "Saturday 01/08/2026" })).toBeTruthy();
    expect(screen.getByText("Hari Kebangsaan")).toBeTruthy();
    expect(screen.getByText("Projects · 1")).toBeTruthy();
    expect(screen.getByText("Tasks due · 2")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();

    fireEvent.click(screen.getByText("SELANGOR [HOUZS] SOLO @ MITEC"));
    expect(onOpenProject).toHaveBeenCalledWith(7);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("says so when no project lands on the day", () => {
    render(<CalendarDayModal iso="2026-08-02" projects={[]} tasks={[]} holidays={[]} onClose={() => {}} onOpenProject={() => {}} />);
    expect(screen.getByText("No projects on this day.")).toBeTruthy();
  });
});
