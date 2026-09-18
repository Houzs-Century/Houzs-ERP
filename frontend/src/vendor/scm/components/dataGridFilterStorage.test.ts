// dataGridFilterStorage — the DataGrid funnel filters. Since 2026-09-16 they
// live in in-visit memory, not localStorage: a funnel survives a client-side
// remount but a fresh bundle evaluation (page load / F5) opens clean. Pins the
// contract: round-trip through memory, empty = entry removed (Clear must not
// leave a "saved view of everything"), per-facet sanitising, and the stale
// dg-filters:* localStorage keys erased on purge.

import { beforeEach, describe, expect, test } from "vitest";
import {
  EMPTY_DATA_GRID_FILTERS,
  isEmptyDataGridFilters,
  purgeStoredDataGridFilters,
  readDataGridFilters,
  resetDataGridFilterMemory,
  sanitizeDataGridFilters,
  writeDataGridFilters,
} from "./dataGridFilterStorage";

const KEY = "dg-test-grid";
const STORED = "dg-filters:dg-test-grid";

beforeEach(() => {
  localStorage.clear();
  resetDataGridFilterMemory();
});

describe("dataGridFilterStorage", () => {
  test("round-trips every facet through in-visit memory, never localStorage", () => {
    const filters = {
      values: { salesperson: ["KINGSLEY", "JUNIE"] },
      dates: { customer_delivery_date: "this_week" },
      numbers: { total_amount: { min: 100 } },
      dateRanges: { so_date: { from: "2026-08-01", to: "2026-08-19" } },
    };
    writeDataGridFilters(KEY, filters);
    // The funnel is remembered for the visit…
    expect(readDataGridFilters(KEY)).toEqual(filters);
    // …but nothing is written to localStorage.
    expect(localStorage.getItem(STORED)).toBeNull();
  });

  test("a fresh bundle evaluation reads clean", () => {
    writeDataGridFilters(KEY, { values: { a: ["x"] }, dates: {}, numbers: {}, dateRanges: {} });
    resetDataGridFilterMemory(); // page load / F5
    expect(readDataGridFilters(KEY)).toEqual(EMPTY_DATA_GRID_FILTERS);
  });

  test("no filters removes the entry", () => {
    writeDataGridFilters(KEY, { values: { a: ["x"] }, dates: {}, numbers: {}, dateRanges: {} });
    writeDataGridFilters(KEY, { ...EMPTY_DATA_GRID_FILTERS });
    expect(readDataGridFilters(KEY)).toEqual(EMPTY_DATA_GRID_FILTERS);
  });

  test("purge erases a pre-2026-09-16 localStorage funnel blob", () => {
    localStorage.setItem(STORED, JSON.stringify({ version: 1, values: { a: ["x"] } }));
    purgeStoredDataGridFilters(KEY);
    expect(localStorage.getItem(STORED)).toBeNull();
    // Purging touches only localStorage, never the in-visit view.
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
