import { describe, expect, it } from "vitest";
import {
  conditionToken,
  dateMatchesPreset,
  isConditionToken,
  parseCondition,
  type Condition,
} from "./dataTableConditionFilters";
import { applyColumnFilters, facetedFilterValues } from "./dataTableRows";

type Row = { id: number; date: string | null; amount: number; status: string };
const rows: Row[] = [
  { id: 1, date: "2026-09-01", amount: 100, status: "Open" },
  { id: 2, date: "2026-09-15", amount: 250, status: "Open" },
  { id: 3, date: "2026-10-02", amount: 900, status: "Closed" },
  { id: 4, date: null, amount: 50, status: "Open" },
];
const columns = [
  { key: "date", getValue: (r: Row) => r.date, dateValue: (r: Row) => r.date },
  { key: "amount", getValue: (r: Row) => r.amount, numberValue: (r: Row) => r.amount },
  { key: "status", getValue: (r: Row) => r.status },
];
const ids = (rs: Row[]) => rs.map((r) => r.id);

describe("condition tokens", () => {
  it.each<Condition>([
    { kind: "preset", preset: "thisWeek" },
    { kind: "dateRange", from: "2026-09-01", to: null },
    { kind: "numRange", min: null, max: 200 },
  ])("round-trips %o", (c) => {
    const t = conditionToken(c);
    expect(isConditionToken(t)).toBe(true);
    expect(parseCondition(t)).toEqual(c);
  });

  it("never mistakes a real cell value for a condition", () => {
    expect(isConditionToken("preset:today")).toBe(false);
    expect(parseCondition("Open")).toBeNull();
  });
});

describe("dateMatchesPreset (MYT)", () => {
  // 2026-09-25 01:00 MYT = 2026-09-24T17:00Z: still the 24th in UTC.
  const now = Date.parse("2026-09-24T17:00:00Z");
  it("uses the Malaysian calendar day", () => {
    expect(dateMatchesPreset("2026-09-25", "today", now)).toBe(true);
    expect(dateMatchesPreset("2026-09-24", "overdue", now)).toBe(true);
    expect(dateMatchesPreset("2026-09-26", "tomorrow", now)).toBe(true);
    expect(dateMatchesPreset("2026-09-21", "thisWeek", now)).toBe(true);
    expect(dateMatchesPreset("2026-09-28", "thisWeek", now)).toBe(false);
    expect(dateMatchesPreset("2026-08-31", "lastMonth", now)).toBe(true);
    expect(dateMatchesPreset(null, "today", now)).toBe(false);
  });
});

describe("applyColumnFilters with conditions", () => {
  it("filters a date range inclusively and drops rows with no date", () => {
    const f = { date: [conditionToken({ kind: "dateRange", from: "2026-09-01", to: "2026-09-30" })] };
    expect(ids(applyColumnFilters(rows, f, columns))).toEqual([1, 2]);
  });

  it("filters a number range", () => {
    const f = { amount: [conditionToken({ kind: "numRange", min: 100, max: 300 })] };
    expect(ids(applyColumnFilters(rows, f, columns))).toEqual([1, 2]);
  });

  it("ANDs a condition with ticked values on the same column", () => {
    const f = { amount: [conditionToken({ kind: "numRange", min: 60, max: null }), "900"] };
    expect(ids(applyColumnFilters(rows, f, columns))).toEqual([3]);
  });

  it("keeps a condition out of the faceted value list", () => {
    const f = { status: [conditionToken({ kind: "numRange", min: 0, max: 1 })] };
    const facets = facetedFilterValues(rows, f, columns[2], columns);
    expect(facets.map(([v]) => v)).toEqual(["Closed", "Open"]);
  });
});
