// dataGridFilterStorage — the persisted DataGrid funnel filters (2026-08-19).
// Pins the storage contract: round-trip, per-facet sanitising (one corrupt
// facet never costs the rest), and empty-filters = key removed (Clear must not
// leave a "saved view of everything" behind).

import { beforeEach, describe, expect, test } from "vitest";
import {
  EMPTY_DATA_GRID_FILTERS,
  isEmptyDataGridFilters,
  readDataGridFilters,
  sanitizeDataGridFilters,
  writeDataGridFilters,
} from "./dataGridFilterStorage";

const KEY = "dg-test-grid";
const STORED = "dg-filters:dg-test-grid";

beforeEach(() => localStorage.clear());

describe("dataGridFilterStorage", () => {
  test("round-trips every facet under dg-filters:<idKey>", () => {
    const filters = {
      values: { salesperson: ["KINGSLEY", "JUNIE"] },
      dates: { customer_delivery_date: "this_week" },
      numbers: { total_amount: { min: 100 } },
      dateRanges: { so_date: { from: "2026-08-01", to: "2026-08-19" } },
    };
    writeDataGridFilters(KEY, filters);
    expect(localStorage.getItem(STORED)).not.toBeNull();
    expect(readDataGridFilters(KEY)).toEqual(filters);
  });

  test("no filters removes the key, and a missing/corrupt blob reads empty", () => {
    writeDataGridFilters(KEY, {
      values: { a: ["x"] },
      dates: {},
      numbers: {},
      dateRanges: {},
    });
    writeDataGridFilters(KEY, { ...EMPTY_DATA_GRID_FILTERS });
    expect(localStorage.getItem(STORED)).toBeNull();

    localStorage.setItem(STORED, "{not json");
    expect(readDataGridFilters(KEY)).toEqual(EMPTY_DATA_GRID_FILTERS);
  });

  test("sanitiser drops one corrupt facet entry without costing the rest", () => {
    const dirty = sanitizeDataGridFilters({
      values: { good: ["a"], bad: "not-an-array", __proto__: ["x"] },
      dates: { ok: "today", drop: 42 },
      numbers: { ok: { min: 1 }, drop: { min: Number.NaN } },
      dateRanges: { ok: { from: "2026-01-01" }, drop: {} },
    });
    expect(dirty.values).toEqual({ good: ["a"] });
    expect(dirty.dates).toEqual({ ok: "today" });
    expect(dirty.numbers).toEqual({ ok: { min: 1 } });
    expect(dirty.dateRanges).toEqual({ ok: { from: "2026-01-01" } });
    expect(isEmptyDataGridFilters(dirty)).toBe(false);
  });
});
