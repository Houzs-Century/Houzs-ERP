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

describe("a row is judged by its Malaysian day (owner 2026-11-09)", () => {
  // 2026-11-10 09:00 in Malaysia.
  const MORNING = Date.parse("2026-11-10T01:00:00Z");
  const at = (v: string) => ({ v });
  const col = { getValue: (r: { v: string }) => r.v };

  it("a row stamped 01:30 Malaysia time on the 10th is Today, not yesterday", () => {
    expect(dateMatchesPreset("2026-11-09T17:30:00Z", "today", MORNING)).toBe(true);
    expect(dateMatchesPreset("2026-11-09T17:30:00+00:00", "today", MORNING)).toBe(true);
    expect(dateMatchesPreset("2026-11-09 17:30:00+00", "today", MORNING)).toBe(true);
    expect(dateMatchesPreset("2026-11-09T17:30:00Z", "overdue", MORNING)).toBe(false);
  });
  it("16:00 UTC on the 9th is still the 10th's 00:00, 15:59 is the 9th", () => {
    expect(dateMatchesPreset("2026-11-09T16:00:00Z", "today", MORNING)).toBe(true);
    expect(dateMatchesPreset("2026-11-09T15:59:59Z", "today", MORNING)).toBe(false);
    expect(dateMatchesPreset("2026-11-09T15:59:59Z", "overdue", MORNING)).toBe(true);
  });
  it("the last hours of 30 November UTC are December in Malaysia", () => {
    const DEC_2 = Date.parse("2026-12-02T02:00:00Z");
    expect(dateMatchesPreset("2026-11-30T16:30:00Z", "thisMonth", DEC_2)).toBe(true);
    expect(dateMatchesPreset("2026-11-30T16:30:00Z", "lastMonth", DEC_2)).toBe(false);
    expect(dateMatchesPreset("2026-11-30T15:30:00Z", "lastMonth", DEC_2)).toBe(true);
  });
  it("a typed From/To counts the Malaysian day too", () => {
    const nov10 = { kind: "dateRange" as const, from: "2026-11-10", to: "2026-11-10" };
    expect(rowMatchesCondition(at("2026-11-09T17:30:00Z"), nov10, col)).toBe(true);
    expect(rowMatchesCondition(at("2026-11-10T15:59:00Z"), nov10, col)).toBe(true);
    expect(rowMatchesCondition(at("2026-11-10T16:00:00Z"), nov10, col)).toBe(false);
  });
  it("a plain date, or a timestamp with no offset, is the day it says", () => {
    expect(dateMatchesPreset("2026-11-10", "today", MORNING)).toBe(true);
    expect(dateMatchesPreset("2026-11-09", "today", MORNING)).toBe(false);
    expect(dateMatchesPreset("2026-11-09T23:30:00", "today", MORNING)).toBe(false);
    expect(rowMatchesCondition(at("2026/11/10"), { kind: "dateRange", from: "2026-11-10", to: "2026-11-10" }, col)).toBe(true);
  });
  it("a value that is not a date matches nothing", () => {
    expect(dateMatchesPreset("09/11/2026", "overdue", MORNING)).toBe(false);
    expect(dateMatchesPreset("", "today", MORNING)).toBe(false);
    expect(dateMatchesPreset(null, "today", MORNING)).toBe(false);
  });
});
