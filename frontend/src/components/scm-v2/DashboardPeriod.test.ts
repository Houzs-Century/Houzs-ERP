import { describe, expect, it } from "vitest";
import { dashboardPeriods, resolvePeriod } from "./DashboardPeriod";

describe("dashboard period (Hookka rule)", () => {
  it("in a quarter's first month there is no This quarter; Last quarter stands in", () => {
    const p = dashboardPeriods("2026-10-17");
    expect(p.filter((x) => x.group === "upToToday").map((x) => [x.key, x.from, x.to])).toEqual([
      ["month", "2026-10-01", "2026-10-17"],
      ["year", "2026-01-01", "2026-10-17"],
    ]);
    expect(p.filter((x) => x.group === "quarter").map((x) => x.key)).toEqual(["Q3-2026", "Q2-2026", "Q1-2026", "Q4-2025"]);
    expect(p.find((x) => x.key === "Q3-2026")).toMatchObject({ from: "2026-07-01", to: "2026-09-30", label: "Last quarter · Q3 2026" });
    expect(p.filter((x) => x.group === "year").map((x) => [x.key, x.from, x.to])).toEqual([["Y2025", "2025-01-01", "2025-12-31"], ["Y2024", "2024-01-01", "2024-12-31"]]);
  });

  it("from a quarter's second month This quarter is offered", () => {
    const p = dashboardPeriods("2026-11-03");
    expect(p.find((x) => x.key === "quarter")).toMatchObject({ from: "2026-10-01", to: "2026-11-03" });
  });

  it("in January This year repeats This month, so only This month shows", () => {
    const p = dashboardPeriods("2027-01-09");
    expect(p.filter((x) => x.group === "upToToday").map((x) => x.key)).toEqual(["month"]);
    expect(p.find((x) => x.key === "Q4-2026")).toMatchObject({ from: "2026-10-01", to: "2026-12-31" });
  });

  it("a past month is whole; no half-year anywhere", () => {
    const p = dashboardPeriods("2026-10-17");
    expect(p.find((x) => x.key === "2026-09")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(p.find((x) => x.key === "2026-02")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(p.some((x) => /half/i.test(x.label))).toBe(false);
  });

  it("opens on this month; names a preset when the dates match, else a date range", () => {
    expect(resolvePeriod(null, null, "2026-10-17").key).toBe("month");
    expect(resolvePeriod("2026-10", "nope", "2026-10-17").key).toBe("month");
    expect(resolvePeriod("2026-01-01", "2026-10-17", "2026-10-17").key).toBe("year");
    expect(resolvePeriod("2026-08-01", "2026-08-31", "2026-10-17").key).toBe("2026-08");
    expect(resolvePeriod("2026-09-10", "2026-10-05", "2026-10-17")).toMatchObject({ key: "custom", from: "2026-09-10", to: "2026-10-05" });
    expect(resolvePeriod("2026-10-05", "2026-09-10", "2026-10-17")).toMatchObject({ from: "2026-09-10", to: "2026-10-05" });
  });
});
