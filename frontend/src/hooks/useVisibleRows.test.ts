// Unit tests for useVisibleRows — the one implementation behind the PO / PI /
// SI / DO stat strips, so the "is a funnel active" test is pinned in one place.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVisibleRows } from "./useVisibleRows";

type Row = { id: number };
const make = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe("useVisibleRows", () => {
  it("falls back to the full page before the table has reported", () => {
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    expect(result.current.rows).toBe(rows);
    expect(result.current.filtered).toBe(false);
  });

  it("reports filtered once the table publishes a narrower set", () => {
    // The reported case: 60 matched, a stuck DATE funnel leaves 5 on screen.
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange(rows.slice(0, 5)));
    expect(result.current.rows).toHaveLength(5);
    expect(result.current.filtered).toBe(true);
  });

  it("is NOT filtered when the funnel keeps every row", () => {
    // A funnel that excludes nothing leaves the tiles and the table agreeing,
    // so flagging "Filtered" there would be noise, not information.
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange([...rows]));
    expect(result.current.filtered).toBe(false);
  });

  it("treats an empty result as a real zero, not as 'not reported yet'", () => {
    // `null` (never reported) and `[]` (funnel matched nothing) must not
    // collapse: the second has to show 0, never fall back to the full page.
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange([]));
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.filtered).toBe(true);
  });

  it("keeps a stable callback identity across renders", () => {
    // DataTable publishes from an effect keyed on this callback — a fresh
    // function each render would re-fire it every render.
    const { result, rerender } = renderHook(({ r }) => useVisibleRows(r), {
      initialProps: { r: make(10) },
    });
    const first = result.current.onFilteredRowsChange;
    rerender({ r: make(10) });
    expect(result.current.onFilteredRowsChange).toBe(first);
  });

  it("re-evaluates against the NEW page after a refetch", () => {
    // Page 2 arrives with 5 rows while the last report still holds 5 from page
    // 1: same length, so no funnel — correct, and the stale rows are replaced
    // by the table's next publish rather than being summed forever.
    const { result, rerender } = renderHook(({ r }) => useVisibleRows(r), {
      initialProps: { r: make(60) },
    });
    act(() => result.current.onFilteredRowsChange(make(5)));
    expect(result.current.filtered).toBe(true);
    rerender({ r: make(5) });
    expect(result.current.filtered).toBe(false);
  });
});
