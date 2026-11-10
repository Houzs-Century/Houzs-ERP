import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { activeFilterSummary, describeFilterValues } from "./DataTableFilterNotice";
import { resetInVisitColFilters } from "./dataTableColFilterMemory";

/* Owner 2026-11-10: Delivery Planning's Overdue tab (37) drew 0 rows and "No
   orders need delivering in this view." A remembered Delivery Date funnel was
   hiding all 37. When rows exist and the funnels / search hide them, the empty
   state must say so and name the filters. */

const Y = 2026;
type Row = { id: string; doc: string; due: string };
const rows: Row[] = [
  { id: "a", doc: "SO-1", due: `${Y}-10-01` },
  { id: "b", doc: "SO-2", due: `${Y}-10-15` },
  { id: "c", doc: "SO-3", due: `${Y}-10-30` },
];
const columns: Column<Row>[] = [
  { key: "doc", label: "Doc No", render: (r) => r.doc, getValue: (r) => r.doc },
  { key: "amended_delivery_date", label: "Delivery date", render: (r) => r.due, getValue: (r) => r.due, dateValue: (r) => r.due },
];
const funnel = { amended_delivery_date: [`\u0001dateRange:${Y}-11-06..${Y}-11-10`] };

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 639px)" ? width < 640 : false,
      media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}
const drawn = () => document.querySelectorAll("tbody tr[data-vrow]").length;
const openWithFunnel = (id: string) =>
  window.history.replaceState(null, "", `/list?cf.${id}=${encodeURIComponent(JSON.stringify(funnel))}`);

beforeEach(() => {
  localStorage.clear();
  resetInVisitColFilters();
  window.history.replaceState(null, "", "/list");
  setViewport(1280);
});
afterEach(cleanup);

describe("filter summary text", () => {
  it("spells out a date range, a preset, a number range and ticked values", () => {
    expect(describeFilterValues(["\u0001dateRange:2026-11-06..2026-11-10"])).toBe("2026/11/06 – 2026/11/10");
    expect(describeFilterValues(["\u0001dateRange:..2026-11-10"])).toBe("until 2026/11/10");
    expect(describeFilterValues(["\u0001dateRange:2026-11-06.."])).toBe("from 2026/11/06");
    expect(describeFilterValues(["\u0001preset:thisWeek"])).toBe("This Week");
    expect(describeFilterValues(["\u0001numRange:10.."])).toBe("at least 10");
    expect(describeFilterValues(["Open", "—"])).toBe("Open, (blank)");
    expect(describeFilterValues(["A", "B", "C"])).toBe("3 values");
  });

  it("names each set funnel by its header label and skips a column that is gone", () => {
    expect(activeFilterSummary({ ...funnel, gone: ["x"], doc: [] }, columns)).toEqual([
      { key: "amended_delivery_date", label: "Delivery Date", detail: describeFilterValues(funnel.amended_delivery_date) },
    ]);
  });
});

describe("DataTable empty state when filters hide every row", () => {
  it("says how many rows the funnel hides and names the column; Clear brings them back", async () => {
    openWithFunnel("fe-funnel");
    render(<DataTable tableId="fe-funnel" columns={columns} rows={rows} getRowKey={(r) => r.id} emptyLabel="No orders need delivering in this view." />);
    const notice = await screen.findByTestId("filtered-empty");
    expect(notice.textContent).toContain("3 rows hidden by your filters: Delivery Date (2026/11/06 – 2026/11/10).");
    expect(screen.queryByText("No orders need delivering in this view.")).toBeNull();

    fireEvent.click(within(notice).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(drawn()).toBe(3));
    expect(screen.queryByTestId("filtered-empty")).toBeNull();
    expect(screen.queryByTestId("active-filters-chip")).toBeNull();
  });

  it("shows the same notice on the phone card list", async () => {
    setViewport(375);
    openWithFunnel("fe-mobile");
    render(<DataTable tableId="fe-mobile" columns={columns} rows={rows} getRowKey={(r) => r.id} emptyLabel="Nothing here" />);
    const notice = await screen.findByTestId("filtered-empty");
    expect(notice.textContent).toContain("3 rows hidden by your filters: Delivery Date (2026/11/06 – 2026/11/10).");
    expect(screen.queryByText("Nothing here")).toBeNull();
  });

  it("names the search text when the search box hides every row, and Clear empties it", async () => {
    render(<DataTable tableId="fe-search" columns={columns} rows={rows} getRowKey={(r) => r.id} clientSearch={{ placeholder: "Find" }} emptyLabel="Nothing here" />);
    fireEvent.change(screen.getByPlaceholderText("Find"), { target: { value: "zzz" } });
    const notice = await screen.findByTestId("filtered-empty");
    expect(notice.textContent).toContain('3 rows hidden by your filters: search "zzz".');

    fireEvent.click(within(notice).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(drawn()).toBe(3));
    expect((screen.getByPlaceholderText("Find") as HTMLInputElement).value).toBe("");
  });

  it("keeps the page's own empty label when there really are no rows", () => {
    openWithFunnel("fe-true-empty");
    render(<DataTable tableId="fe-true-empty" columns={columns} rows={[]} getRowKey={(r) => r.id} emptyLabel="No orders need delivering in this view." />);
    expect(screen.getByText("No orders need delivering in this view.")).toBeTruthy();
    expect(screen.queryByTestId("filtered-empty")).toBeNull();
  });
});

describe("active-filters chip", () => {
  it("stays in the toolbar while a funnel is set, even with rows visible, and clears it", async () => {
    const wide = { amended_delivery_date: [`\u0001dateRange:${Y}-10-10..${Y}-10-31`] };
    window.history.replaceState(null, "", `/list?cf.fe-chip=${encodeURIComponent(JSON.stringify(wide))}`);
    render(<DataTable tableId="fe-chip" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    await waitFor(() => expect(drawn()).toBe(2));
    const chip = screen.getByTestId("active-filters-chip");
    expect(chip.textContent).toContain("Filters on: Delivery Date");

    fireEvent.click(within(chip).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(drawn()).toBe(3));
    expect(screen.queryByTestId("active-filters-chip")).toBeNull();
  });
});
