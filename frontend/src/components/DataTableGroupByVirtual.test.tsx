/* Owner follow-up 2026-10-23 (Delivery Planning board): the All tab groups rows
 * by month through DataTable's CODE-DRIVEN `groupBy` prop (distinct from the
 * drag-to-group `groupBanner` path), and — the part the owner explicitly asked
 * for — a grouped list now WINDOWS instead of rendering every row to the DOM.
 * These tests pin both: the collapsible month headers with counts and the
 * trailing "No date" bucket, collapse hiding a group's rows, and that a long
 * grouped list renders only a slice while keeping its group headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

type Row = { id: number; name: string; month: string };

const columns: Column<Row>[] = [
  { key: "name", label: "Name", render: (r) => r.name, getValue: (r) => r.name },
  // The grouping key column: its getValue is the raw bucket value, as the board's
  // hidden `delivery_month` column supplies deliveryMonthKey().
  { key: "month", label: "Month", render: (r) => r.month, getValue: (r) => r.month },
];

// Mirrors the board's MONTH_GROUP_BY.label (deliveryMonthLabel): '' -> "No date".
const monthLabel = (v: string) => (v ? `Month ${v}` : "No date");
const groupBy = { key: "month", label: monthLabel };

const groupHeaders = () =>
  Array.from(document.querySelectorAll("tbody tr[data-vgrp]")).map((tr) =>
    String(tr.textContent).replace(/\s+/g, " ").trim(),
  );
const dataRowCount = () => document.querySelectorAll("tbody tr[data-vrow]").length;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DataTable code-driven groupBy (month grouping)", () => {
  it("renders a collapsible header per bucket with its count, No-date group last", () => {
    const rows: Row[] = [
      { id: 1, name: "a", month: "2026-09" },
      { id: 2, name: "b", month: "2026-10" },
      { id: 3, name: "c", month: "2026-10" },
      { id: 4, name: "d", month: "" }, // no delivery date -> trailing bucket
    ];
    render(
      <DataTable tableId="gb-month" columns={columns} rows={rows} getRowKey={(r) => r.id} groupBy={groupBy} />,
    );
    // First-seen bucket order over the (already-sorted) rows; the empty key sorts
    // in wherever it appears — here the caller passes it last, as the board's
    // delivery-date default sort does (no-date rows sort last).
    expect(groupHeaders()).toEqual(["Month 2026-09(1)", "Month 2026-10(2)", "No date(1)"]);
    expect(dataRowCount()).toBe(4);
  });

  it("collapsing a month hides only that month's rows", () => {
    const rows: Row[] = [
      { id: 1, name: "a", month: "2026-09" },
      { id: 2, name: "b", month: "2026-10" },
      { id: 3, name: "c", month: "2026-10" },
    ];
    render(
      <DataTable tableId="gb-collapse" columns={columns} rows={rows} getRowKey={(r) => r.id} groupBy={groupBy} />,
    );
    expect(dataRowCount()).toBe(3);
    // Click the Oct header (2 rows) -> only those collapse.
    fireEvent.click(document.querySelectorAll("tbody tr[data-vgrp]")[1]!);
    expect(dataRowCount()).toBe(1);
    expect(groupHeaders()).toEqual(["Month 2026-09(1)", "Month 2026-10(2)"]);
  });

  it("windows a long grouped list: renders a slice, not every row, and keeps headers", () => {
    // Every drawn item (row or group header) is one 33px line, as on the board.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("tr[data-vrow], tr[data-vgrp]") ? 33 : 0;
    });
    // 90 rows across 3 months -> renderList = 90 rows + 3 headers = 93 items,
    // well past VIRTUAL_ROW_THRESHOLD (30), so the grouped list must window.
    const months = ["2026-09", "2026-10", "2026-11"];
    const rows: Row[] = Array.from({ length: 90 }, (_, i) => ({
      id: i + 1,
      name: `Order ${i + 1}`,
      month: months[Math.floor(i / 30)]!,
    }));
    const { container } = render(
      <DataTable tableId="gb-window" columns={columns} rows={rows} getRowKey={(r) => r.id} groupBy={groupBy} />,
    );
    // Windowed: not all 90 data rows are in the DOM...
    expect(dataRowCount()).toBeLessThan(90);
    expect(dataRowCount()).toBeGreaterThan(0);
    // ...but group headers still render, and a spacer <tr> reserves the off-screen
    // height (so the scrollbar is unchanged).
    expect(groupHeaders().length).toBeGreaterThan(0);
    expect(container.querySelector("tr[aria-hidden]")).not.toBeNull();
  });
});
