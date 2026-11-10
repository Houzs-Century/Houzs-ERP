/* The phone calendar's search covers ALL dates, like desktop: it counts every
   match, Enter / Next jump to the month of the next one, and an empty result
   says so instead of drawing an empty month. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ paths: [] as string[] }));

const match = (id: number, start: string) => ({
  id,
  code: `HZ-${id}`,
  name: `Selangor [HOUZS] EXPO ${id} @ SETIA CITY CONVENTION CENTRE`,
  status: "confirmed",
  brand: "HOUZS",
  organizer: "EXPO",
  start_date: start,
  end_date: null,
  venue: "SETIA CITY CONVENTION CENTRE",
  state: "Selangor",
  event_type_name: null,
});

vi.mock("../api/client", () => ({
  api: {
    get: async (path: string) => {
      h.paths.push(path);
      if (path.startsWith("/api/projects/calendar/search")) {
        if (path.includes("q=nothing")) return { matches: [], total: 0, truncated: false, cap: 300 };
        return { matches: [match(1, "2026-02-03"), match(2, "2027-03-09")], total: 2, truncated: false, cap: 300 };
      }
      if (path.startsWith("/api/projects/calendar/events")) return { projects: [], tasks: [] };
      return { data: [] };
    },
  },
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ pageAccess: () => "full" }) }));
vi.mock("../hooks/useBranding", () => ({ useBranding: () => ({ companyCode: "HOUZS", companyName: "Houzs Century" }) }));

import { MobileCalendar } from "./MobileCalendar";

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MobileCalendar />
    </QueryClientProvider>,
  );

beforeEach(() => {
  h.paths.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T04:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("phone calendar all-dates search", () => {
  it("finds matches in other months and jumps to them", async () => {
    mount();
    expect(screen.getByText("November 2026")).toBeTruthy();
    const box = screen.getByLabelText("Search events");
    fireEvent.change(box, { target: { value: "sccc" } });
    expect(await screen.findByText("2 events match 'sccc'")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /All matches/ }));
    const rows = within(screen.getByRole("list", { name: "All matching events" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("03/02/2026"),
      expect.stringContaining("09/03/2027"),
    ]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("March 2027")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Previous match/ }));
    expect(await screen.findByText("February 2026")).toBeTruthy();
  });

  it("says so when nothing matches", async () => {
    mount();
    fireEvent.change(screen.getByLabelText("Search events"), { target: { value: "nothing" } });
    expect(await screen.findByText("No events match 'nothing'")).toBeTruthy();
    expect(screen.queryByText("MON")).toBeNull();
  });
});
