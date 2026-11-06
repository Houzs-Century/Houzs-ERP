import { describe, expect, it } from "vitest";
import {
  conditionDateRange, conditionToken, dateMatchesPreset, looksLikeDateColumn, presetRange, rowMatchesCondition,
} from "./dataTableConditionFilters";

// 2026-11-06, a Friday, 10:00 in Malaysia.
const NOW = Date.parse("2026-11-06T02:00:00Z");

describe("a date column gets the date filter by itself", () => {
  it("every cell a date, placeholders aside", () => {
    expect(looksLikeDateColumn(["2026-11-06", "2023-08-20T00:00:00Z", "—", ""])).toBe(true);
    expect(looksLikeDateColumn(["2026/11/06"])).toBe(true);
  });
  it("a column of anything else stays as it was", () => {
    expect(looksLikeDateColumn(["HC-SO-2611-070", "2026-11-06"])).toBe(false);
    expect(looksLikeDateColumn(["—"])).toBe(false);
    expect(looksLikeDateColumn([])).toBe(false);
  });
  it("a date shown with slashes still falls in its range", () => {
    expect(rowMatchesCondition({ d: "2026/11/06" }, { kind: "dateRange", from: "2026-11-01", to: "2026-11-30" }, { getValue: (r) => r.d })).toBe(true);
  });
});

describe("a server-paged list asks the server for the range", () => {
  it("each preset is the same days the grid would keep", () => {
    expect(presetRange("today", NOW)).toEqual({ from: "2026-11-06", to: "2026-11-06" });
    expect(presetRange("tomorrow", NOW)).toEqual({ from: "2026-11-07", to: "2026-11-07" });
    expect(presetRange("thisWeek", NOW)).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(presetRange("thisMonth", NOW)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(presetRange("lastMonth", NOW)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("overdue", NOW)).toEqual({ to: "2026-11-05" });
    expect(dateMatchesPreset("2026-11-05", "overdue", NOW)).toBe(true);
    expect(dateMatchesPreset("2026-11-06", "overdue", NOW)).toBe(false);
  });
  it("a typed range goes through, and ticked values alone ask for none", () => {
    expect(conditionDateRange([conditionToken({ kind: "dateRange", from: "2026-01-01", to: null })], NOW)).toEqual({ from: "2026-01-01" });
    expect(conditionDateRange([conditionToken({ kind: "preset", preset: "today" }), "2026-11-01"], NOW)).toEqual({ from: "2026-11-06", to: "2026-11-06" });
    expect(conditionDateRange(["2026-11-01"], NOW)).toEqual({});
    expect(conditionDateRange(undefined, NOW)).toEqual({});
  });
});
