/* The Projects calendar (desktop) opens on, and its "Today" button returns to,
   the MALAYSIAN today. Before 08:00 Malaysia time, on a machine whose clock
   zone is UTC, it opened last month on the 1st and last week on a Monday.
   Run with TZ=UTC. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: async (path: string) => {
        h.paths.push(path);
        return path.startsWith("/api/projects/calendar/events") ? { projects: [], tasks: [] } : { data: [] };
      },
    },
  };
});
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ show: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ProjectsCalendarView } from "./ProjectsCalendarView";
import { buildCalendarWindow } from "./calendarModel";

const mount = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <ProjectsCalendarView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const lastEventsCall = () => [...h.paths].reverse().find((p) => p.startsWith("/api/projects/calendar/events"));

beforeEach(() => {
  h.paths.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Projects calendar window with no month or week in the URL", () => {
  it("month: at 01:30 on 1 Dec (Malaysia) the window is December", () => {
    vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
    const w = buildCalendarWindow("month", "", "");
    expect(w.anchor.getFullYear()).toBe(2026);
    expect(w.anchor.getMonth()).toBe(11);
    expect(w.fromStr).toBe("2026-11-30");
  });

  it("week: at 01:30 on Monday 16 Nov (Malaysia) the week starts on the 16th", () => {
    vi.setSystemTime(new Date("2026-11-15T17:30:00Z"));
    const w = buildCalendarWindow("week", "", "");
    expect(w.fromStr).toBe("2026-11-16");
    expect(w.toStr).toBe("2026-11-22");
  });
});

describe("ProjectsCalendarView", () => {
  it("opens on the Malaysian month at 01:30 on 1 Dec", async () => {
    vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
    mount("/projects?view=calendar");
    expect(await screen.findByText("December 2026")).toBeTruthy();
  });

  it("Today in week mode lands on the Malaysian week, Monday first", async () => {
    vi.setSystemTime(new Date("2026-11-15T17:30:00Z")); // Monday 16 Nov, 01:30 in Malaysia
    mount("/projects?view=calendar&mode=week&week=2026-10-05");
    await waitFor(() => expect(lastEventsCall()).toContain("from=2026-10-05"));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(lastEventsCall()).toContain("from=2026-11-16&to=2026-11-22"));
  });

  it("Today in month mode lands on the Malaysian month", async () => {
    vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
    mount("/projects?view=calendar&month=2026-08");
    expect(await screen.findByText("August 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(await screen.findByText("December 2026")).toBeTruthy();
  });
});
