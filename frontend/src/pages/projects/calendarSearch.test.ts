import { describe, expect, it } from "vitest";
import { type CalendarMatch, matchDateRange, monthPeriod, pickAdjacentMatch, weekStartOf } from "./calendarSearch";

const m = (id: number, start: string, end: string | null = null): CalendarMatch => ({
  id,
  code: `P-${id}`,
  name: `Fair ${id}`,
  status: "confirmed",
  brand: null,
  organizer: null,
  start_date: start,
  end_date: end,
  venue: "SETIA CITY CONVENTION CENTRE",
  state: null,
  event_type_name: null,
});

// Sorted by start date, as the endpoint returns them.
const matches = [m(1, "2026-03-02"), m(2, "2026-11-05", "2026-11-08"), m(3, "2026-11-20"), m(4, "2027-01-10")];
const nov = monthPeriod(2026, 10);

describe("pickAdjacentMatch", () => {
  it("with nothing focused, Next is the first match after the visible month and Previous the last before it", () => {
    expect(pickAdjacentMatch({ matches, focusedId: null, periodStart: nov.start, periodEnd: nov.end, direction: "next" })?.id).toBe(4);
    expect(pickAdjacentMatch({ matches, focusedId: null, periodStart: nov.start, periodEnd: nov.end, direction: "prev" })?.id).toBe(1);
  });

  it("skips empty months: from June, Next lands in November", () => {
    const jun = monthPeriod(2026, 5);
    expect(pickAdjacentMatch({ matches, focusedId: null, periodStart: jun.start, periodEnd: jun.end, direction: "next" })?.id).toBe(2);
  });

  it("steps one match at a time while the focused match is on screen, even inside one month", () => {
    expect(pickAdjacentMatch({ matches, focusedId: 2, periodStart: nov.start, periodEnd: nov.end, direction: "next" })?.id).toBe(3);
    expect(pickAdjacentMatch({ matches, focusedId: 3, periodStart: nov.start, periodEnd: nov.end, direction: "prev" })?.id).toBe(2);
  });

  it("ignores a focused match that is no longer on screen and goes by the visible period", () => {
    const feb = monthPeriod(2026, 1);
    expect(pickAdjacentMatch({ matches, focusedId: 3, periodStart: feb.start, periodEnd: feb.end, direction: "next" })?.id).toBe(1);
  });

  it("returns null at either end of the list", () => {
    expect(pickAdjacentMatch({ matches, focusedId: 4, periodStart: "2027-01-01", periodEnd: "2027-01-31", direction: "next" })).toBeNull();
    expect(pickAdjacentMatch({ matches, focusedId: 1, periodStart: "2026-03-01", periodEnd: "2026-03-31", direction: "prev" })).toBeNull();
    expect(pickAdjacentMatch({ matches: [], focusedId: null, periodStart: nov.start, periodEnd: nov.end, direction: "next" })).toBeNull();
  });

  it("works on a week period", () => {
    const wk = { start: "2026-11-02", end: "2026-11-08" };
    expect(pickAdjacentMatch({ matches, focusedId: null, periodStart: wk.start, periodEnd: wk.end, direction: "next" })?.id).toBe(3);
  });
});

describe("period helpers", () => {
  it("monthPeriod covers the whole month, leap February included", () => {
    expect(monthPeriod(2028, 1)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
  it("weekStartOf snaps to Monday", () => {
    expect(weekStartOf("2026-11-08")).toBe("2026-11-02"); // Sunday
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02"); // Monday
  });
  it("matchDateRange prints DD/MM/YYYY", () => {
    expect(matchDateRange(m(9, "2026-11-05", "2026-11-08"))).toBe("05/11/2026 – 08/11/2026");
    expect(matchDateRange(m(9, "2026-11-05"))).toBe("05/11/2026");
  });
});
