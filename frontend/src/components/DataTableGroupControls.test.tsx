/* Owner 2026-10-24 ("like Google Sheets"): the Delivery Planning board's grouping
 * is USER-CONTROLLED (default off) — he picks the column, groups by it, and folds
 * groups with a per-group toggle OR a collapse-all / expand-all control. These
 * tests pin that engine behaviour generically (the board just configures it):
 * default ungrouped, group by a by-day and a by-month date column with a trailing
 * "No date" bucket, per-group collapse, and collapse-all / expand-all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

type Row = { id: number; name: string; date: string | null };

// Mirrors the board's two date-grouping columns: by DAY (amended_delivery_date)
// and by MONTH (delivery_month), each formatted in the app's YYYY/MM(/DD) order,
// null -> "No date" (which sorts last: "N" > a digit).
const dayValue = (d: string | null) => (d ? d.replaceAll("-", "/") : "No date");
const monthValue = (d: string | null) => (d ? d.slice(0, 7).replace("-", "/") : "No date");

const columns: Column<Row>[] = [
  { key: "name", label: "Name", render: (r) => r.name, getValue: (r) => r.name },
  { key: "day", label: "Delivery Date", render: (r) => r.date ?? "—", getValue: (r) => dayValue(r.date) },
  { key: "month", label: "Delivery Month", render: (r) => r.date?.slice(0, 7) ?? "—", getValue: (r) => monthValue(r.date) },
];

const rows: Row[] = [
  { id: 1, name: "a", date: "2026-10-15" },
  { id: 2, name: "b", date: "2026-10-20" },
  { id: 3, name: "c", date: "2026-11-01" },
  { id: 4, name: "d", date: null }, // not yet delivered -> trailing "No date"
];

const groupHeaders = () =>
  Array.from(document.querySelectorAll("tbody tr"))
    .filter((tr) => !tr.hasAttribute("data-vrow"))
    .map((tr) => String(tr.textContent).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
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
afterEach(cleanup);

describe("DataTable user-controlled grouping + fold-all", () => {
  it("defaults to UNGROUPED when no column has been picked", () => {
    render(<DataTable tableId="g-off" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(groupHeaders()).toEqual([]); // no group rows
    expect(dataRowCount()).toBe(4); // flat
    // The empty banner invites grouping instead of forcing it.
    expect(screen.getByText(/Drag a column header here to group/)).toBeTruthy();
  });

  it("groups by DAY with a trailing No-date bucket", () => {
    localStorage.setItem("dt:groupby:g-day", JSON.stringify(["day"]));
    render(<DataTable tableId="g-day" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(groupHeaders()).toEqual([
      "Delivery Date: 2026/10/15(1)",
      "Delivery Date: 2026/10/20(1)",
      "Delivery Date: 2026/11/01(1)",
      "Delivery Date: No date(1)",
    ]);
  });

  it("groups by MONTH with a trailing No-date bucket", () => {
    localStorage.setItem("dt:groupby:g-month", JSON.stringify(["month"]));
    render(<DataTable tableId="g-month" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(groupHeaders()).toEqual([
      "Delivery Month: 2026/10(2)",
      "Delivery Month: 2026/11(1)",
      "Delivery Month: No date(1)",
    ]);
  });

  it("folds one group with its header toggle, leaving siblings open", () => {
    localStorage.setItem("dt:groupby:g-one", JSON.stringify(["month"]));
    render(<DataTable tableId="g-one" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(dataRowCount()).toBe(4);
    fireEvent.click(screen.getByText("Delivery Month: 2026/10").closest("tr")!);
    expect(dataRowCount()).toBe(2); // only Oct's 2 rows hidden
  });

  it("collapse-all folds every group to its header; expand-all opens them", () => {
    localStorage.setItem("dt:groupby:g-all", JSON.stringify(["month"]));
    render(<DataTable tableId="g-all" groupBanner columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(dataRowCount()).toBe(4);

    fireEvent.click(screen.getByRole("button", { name: /Collapse all/ }));
    expect(dataRowCount()).toBe(0); // every bucket folded to its header
    expect(groupHeaders().length).toBe(3); // the three month headers remain

    fireEvent.click(screen.getByRole("button", { name: /Expand all/ }));
    expect(dataRowCount()).toBe(4);
  });
});
