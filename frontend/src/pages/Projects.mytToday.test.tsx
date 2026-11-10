/* Two "today" reads on the project page, both now the Malaysian day:
   - the stage tracker's "Nd late" under an overdue step;
   - a task section's "Nd left / due today / Nd overdue" chip.
   At 01:30 on 10 Nov (Malaysia), on a machine whose clock zone is UTC, both
   counted from the 9th. Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../auth/AuthContext", async (orig) => ({
  ...(await orig<typeof import("../auth/AuthContext")>()),
  useAuth: () => ({ user: { id: 1, name: "Test" }, can: () => true, pageAccess: () => "full" }),
}));

import { ProjectStageStepper, TasklistSections } from "./Projects";
import { PROJECT_STAGES } from "./projects/projectStage";

type StepperProps = Parameters<typeof ProjectStageStepper>[0];
type SectionsProps = Parameters<typeof TasklistSections>[0];
import { DialogProvider } from "../hooks/useDialog";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z")); // 01:30 on 10 Nov in Malaysia
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const FLOORPLAN_OPEN = [{ id: 1, title: PROJECT_STAGES[0].titles[0], status: "pending" }] as unknown as StepperProps["checklist"];
const ymdPlus = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

describe("stage tracker counts lateness from the Malaysian today", () => {
  it("a first step due on the 9th is 1d late on the 10th", () => {
    const startDate = ymdPlus("2026-11-09", -PROJECT_STAGES[0].offset);
    render(<ProjectStageStepper checklist={FLOORPLAN_OPEN} startDate={startDate} setupCrew={null} setupStartAt={null} />);
    expect(screen.getByText("1d late")).toBeTruthy();
  });

  it("a first step due on the 10th is not late yet", () => {
    const startDate = ymdPlus("2026-11-10", -PROJECT_STAGES[0].offset);
    render(<ProjectStageStepper checklist={FLOORPLAN_OPEN} startDate={startDate} setupCrew={null} setupStartAt={null} />);
    expect(screen.queryByText(/d late/)).toBeNull();
  });
});

describe("task section chip counts days from the Malaysian today", () => {
  const mount = (due: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}><MemoryRouter><DialogProvider>
        <TasklistSections
          projectId={1}
          projectName="Expo"
          projectStartDate={null}
          projectEndDate={null}
          checklist={[{ id: 1, title: "Book hall", status: "pending", due_date: due, section_id: null }] as unknown as SectionsProps["checklist"]}
          sections={[]}
          sectionProgress={[]}
          attachments={[]}
          comments={[]}
          users={[]}
          canTick={false}
          canManage={false}
          addItemOpen={false}
          setAddItemOpen={() => {}}
          onReload={() => {}}
          onItemStatus={() => {}}
          onItemDelete={() => {}}
          toast={{ success: () => {}, error: () => {}, info: () => {}, warning: () => {}, show: () => {} } as unknown as SectionsProps["toast"]}
        />
      </DialogProvider></MemoryRouter></QueryClientProvider>,
    );

  it("due on the 10th reads 'due today'", () => {
    mount("2026-11-10");
    expect(screen.getByText("due today")).toBeTruthy();
  });

  it("due on the 9th reads '1d overdue'", () => {
    mount("2026-11-09");
    expect(screen.getByText("1d overdue")).toBeTruthy();
  });
});
