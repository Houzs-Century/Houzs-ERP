import { describe, expect, it } from "vitest";
import {
  hasCalendarFilter,
  matchesCalendarSearch,
  searchCalendarRows,
  type CalendarSearchRow,
} from "../src/services/calendarSearch";
import { calendarCrewScope } from "../src/routes/lib/calendar-visibility";

const row = (over: Partial<CalendarSearchRow>): CalendarSearchRow => ({
  id: 1,
  code: "P-1",
  name: "SELANGOR [ZANOTTI] SOLO @ SETIA CITY CONVENTION CENTRE",
  status: "confirmed",
  brand: "ZANOTTI",
  organizer: "Expo Co",
  start_date: "2026-11-05",
  end_date: "2026-11-08",
  venue: "SETIA CITY CONVENTION CENTRE",
  state: "Selangor",
  event_type_name: "Solo",
  ...over,
});

const none = { q: "", brand: "", status: "", organizer: "" };

describe("calendar all-dates search", () => {
  it("matches venue initials, the way the calendar grid does", () => {
    expect(matchesCalendarSearch(row({}), { ...none, q: "sccc" })).toBe(true);
    expect(matchesCalendarSearch(row({ venue: "MID VALLEY", name: "KL fair" }), { ...none, q: "sccc" })).toBe(false);
  });

  it("applies brand, status and organizer exactly", () => {
    expect(matchesCalendarSearch(row({}), { ...none, brand: "OTHER" })).toBe(false);
    expect(matchesCalendarSearch(row({ status: "Pending" }), { ...none, status: "pending" })).toBe(true);
    expect(matchesCalendarSearch(row({}), { ...none, organizer: "Expo Co" })).toBe(true);
  });

  it("an empty search and no filters is not a search", () => {
    expect(hasCalendarFilter(none)).toBe(false);
    expect(hasCalendarFilter({ ...none, q: "  " })).toBe(false);
    expect(hasCalendarFilter({ ...none, status: "pending" })).toBe(true);
  });

  it("sorts by start date across months and says when it cut", () => {
    const rows = [
      row({ id: 3, start_date: "2027-01-10" }),
      row({ id: 1, start_date: "2026-03-02" }),
      row({ id: 2, start_date: "2026-11-05" }),
      row({ id: 9, venue: "MID VALLEY", name: "x", start_date: "2026-01-01" }),
    ];
    const all = searchCalendarRows(rows, { ...none, q: "sccc" }, 10);
    expect(all.matches.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(all).toMatchObject({ total: 3, truncated: false });

    const cut = searchCalendarRows(rows, { ...none, q: "sccc" }, 2);
    expect(cut.matches.map((m) => m.id)).toEqual([1, 2]);
    expect(cut).toMatchObject({ total: 3, truncated: true });
  });
});

describe("calendar visibility shared by the month feed and the search", () => {
  const ctx = (user: unknown) => ({ get: () => user }) as unknown as Parameters<typeof calendarCrewScope>[0];
  const base = { id: 42, name: "Ali", role_name: "Staff", position_name: null, permissions: [] as string[] };

  it("fails closed with no session", () => {
    expect(calendarCrewScope(ctx(undefined))).toEqual({ scopeWhere: " AND 1 = 0", scopeBinds: [] });
  });

  it("an admin or office user sees the whole company calendar", () => {
    expect(calendarCrewScope(ctx({ ...base, permissions: ["*"] })).scopeWhere).toBe("");
    expect(calendarCrewScope(ctx(base)).scopeWhere).toBe("");
  });

  it("a driver without projects.write sees only events they are crewed or attending on", () => {
    const s = calendarCrewScope(ctx({ ...base, position_name: "Driver" }));
    expect(s.scopeWhere).toContain("p.setup_driver_user_id = ?");
    expect(s.scopeWhere).toContain("project_sales_attendees");
    expect(s.scopeBinds).toEqual([42, 42, 42, 42, 42, 42, '%"ali"%', '%"ali"%', 42]);
    expect(calendarCrewScope(ctx({ ...base, position_name: "Driver", permissions: ["projects.write"] })).scopeWhere).toBe("");
  });
});
