/* Calendar search across ALL dates (owner 2026-11-10): the strip counts every
 * match, lists them across months, jumps with Next / Enter, and says so when
 * nothing matches instead of drawing an empty month. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

const match = (id: number, start: string, venue: string, status: string) => ({
  id,
  code: `HZ-${id}`,
  name: `Selangor [HOUZS] EXPO ${id} @ ${venue}`,
  status,
  brand: "HOUZS",
  organizer: "EXPO",
  start_date: start,
  end_date: null,
  venue,
  state: "Selangor",
  event_type_name: null,
});

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: async (path: string) => {
        h.paths.push(path);
        if (path.startsWith("/api/projects/calendar/search")) {
          if (path.includes("q=nothing")) return { matches: [], total: 0, truncated: false, cap: 300 };
          return {
            matches: [
              match(1, "2026-03-02", "SETIA CITY CONVENTION CENTRE", "confirmed"),
              match(2, "2026-09-14", "SETIA CITY CONVENTION CENTRE", "pending"),
              match(3, "2027-01-10", "SETIA CITY CONVENTION CENTRE", "cancelled"),
            ],
            total: 3,
            truncated: false,
            cap: 300,
          };
        }
        if (path.startsWith("/api/projects/calendar/events")) return { projects: [], tasks: [] };
        return { data: [] };
      },
    },
  };
});
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ show: () => {}, success: () => {}, error: () => {}, info: () => {}, warning: () => {} }),
}));

import { ProjectsCalendarView } from "./ProjectsCalendarView";

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <ProjectsCalendarView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectsCalendarView all-dates search", () => {
  it("counts and lists every match across months, sorted by date", async () => {
    renderAt("/projects?view=calendar&month=2026-08&q=sccc");
    expect(await screen.findByText("3 events match 'sccc'")).toBeTruthy();
    expect(h.paths.some((p) => p === "/api/projects/calendar/search?q=sccc")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /All matches/ }));
    const list = screen.getByRole("list", { name: "All matching events" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("02/03/2026"),
      expect.stringContaining("14/09/2026"),
      expect.stringContaining("10/01/2027"),
    ]);
    expect(rows[2].textContent).toContain("SETIA CITY CONVENTION CENTRE");

    // Clicking a row jumps the calendar to that event's month.
    fireEvent.click(rows[2]);
    expect(await screen.findByText("January 2027")).toBeTruthy();
  });

  it("Next match and Enter jump to the month of the next match", async () => {
    renderAt("/projects?view=calendar&month=2026-04&q=sccc");
    expect(await screen.findByText("3 events match 'sccc'")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Next match/ }));
    expect(await screen.findByText("September 2026")).toBeTruthy();

    fireEvent.keyDown(screen.getByPlaceholderText(/Search venue/), { key: "Enter" });
    expect(await screen.findByText("January 2027")).toBeTruthy();
    // Nothing after the last match.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Next match/ }) as HTMLButtonElement).disabled).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: /Previous match/ }));
    expect(await screen.findByText("September 2026")).toBeTruthy();
  });

  it("says so when nothing matches, instead of showing an empty month", async () => {
    const { container } = renderAt("/projects?view=calendar&month=2026-08&q=nothing");
    expect(await screen.findByText("No events match 'nothing'")).toBeTruthy();
    const grid = container.querySelector("[hidden]");
    expect(grid?.textContent).toContain("Mon");
    expect(screen.queryByRole("button", { name: /Next match/ })).toBeNull();
  });
});
