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
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange(rows.slice(0, 5)));
    expect(result.current.rows).toHaveLength(5);
    expect(result.current.filtered).toBe(true);
  });

  it("is NOT filtered when the funnel keeps every row", () => {
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange([...rows]));
    expect(result.current.filtered).toBe(false);
  });

  it("treats an empty result as a real zero, not as 'not reported yet'", () => {
    const rows = make(60);
    const { result } = renderHook(() => useVisibleRows(rows));
    act(() => result.current.onFilteredRowsChange([]));
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.filtered).toBe(true);
  });

  it("keeps a stable callback identity across renders", () => {
    const { result, rerender } = renderHook(({ r }) => useVisibleRows(r), {
      initialProps: { r: make(10) },
    });
    const first = result.current.onFilteredRowsChange;
    rerender({ r: make(10) });
    expect(result.current.onFilteredRowsChange).toBe(first);
  });

  it("re-evaluates against the NEW page after a refetch", () => {
    const { result, rerender } = renderHook(({ r }) => useVisibleRows(r), {
      initialProps: { r: make(60) },
    });
    act(() => result.current.onFilteredRowsChange(make(5)));
    expect(result.current.filtered).toBe(true);
    rerender({ r: make(5) });
    expect(result.current.filtered).toBe(false);
  });
});
