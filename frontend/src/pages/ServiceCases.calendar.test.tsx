/* The Service Cases calendar opens on this month and rings today — both on the
   MALAYSIAN calendar (owner 2026-11-09). It used to read the device's clock, so
   at 01:30 on 1 December in Malaysia a machine on UTC opened on November. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: { get: apiGet },
}));
vi.mock("../hooks/useQuery", () => ({
  useQuery: (_key: string, fn: () => Promise<unknown>) => {
    void fn();
    return { data: { data: [], total: 0 }, loading: false, error: null, fetching: false, placeholder: false, reload: () => undefined };
  },
}));

import { CasesCalendarView } from "./ServiceCases";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 01:30 on 1 December in Malaysia; still 30 November in UTC.
  vi.setSystemTime(new Date("2026-11-30T17:30:00Z"));
  apiGet.mockReset();
  apiGet.mockResolvedValue({ data: [], total: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Service Cases calendar", () => {
  it("opens on the Malaysian month and asks for that month's grid", () => {
    render(
      <MemoryRouter initialEntries={["/service-cases?view=calendar"]}>
        <CasesCalendarView filters={{}} onOpen={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("12/2026");
    // December 2026 starts on a Tuesday, so the Monday-first grid opens on 30 Nov.
    expect(String(apiGet.mock.calls[0]?.[0])).toMatch(/from=2026-11-30.*to=2027-01-10|to=2027-01-10.*from=2026-11-30/);
  });
});
