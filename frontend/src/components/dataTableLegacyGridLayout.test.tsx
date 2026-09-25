import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";
import { gridLayoutToTableLayout } from "./dataTableLegacyGridLayout";
import { writeDataGridLayout } from "../vendor/scm/components/dataGridLayoutStorage";

const facts = [
  { key: "no" },
  { key: "customer" },
  { key: "remark", defaultHidden: true },
  { key: "agent", defaultHidden: true },
];
const grid = (over: Partial<Parameters<typeof gridLayoutToTableLayout>[0]>) => ({
  order: [], hidden: [], widths: {}, pinned: [], groupBy: [], ...over,
});

describe("gridLayoutToTableLayout", () => {
  it("keeps DataTable's defaults when the grid never hid anything", () => {
    expect(gridLayoutToTableLayout(grid({ order: ["customer", "no"] }), facts)).toMatchObject({
      order: ["customer", "no"], hidden: [], shown: [],
    });
  });

  it("shows every defaultHidden column the grid user did not hide", () => {
    // DataGrid drops the defaultHidden flags once its hidden list is non-empty.
    expect(gridLayoutToTableLayout(grid({ hidden: ["customer", "agent"] }), facts)).toMatchObject({
      hidden: ["customer", "agent"], shown: ["remark"],
    });
  });

  it("drops keys the table no longer has and never freezes a hidden column", () => {
    const out = gridLayoutToTableLayout(
      grid({ order: ["__select__", "no", "gone"], hidden: ["customer"], pinned: ["customer", "no"],
        widths: { no: 90, gone: 50 }, groupBy: ["gone", "customer"] }),
      facts,
    );
    expect(out).toMatchObject({ order: ["no"], pinned: ["no"], widths: { no: 90 }, groupBy: ["customer"] });
  });
});

type Row = { id: number; no: string; customer: string; remark: string };
const columns: Column<Row>[] = [
  { key: "no", label: "No", render: (r) => r.no, getValue: (r) => r.no },
  { key: "customer", label: "Customer", render: (r) => r.customer, getValue: (r) => r.customer },
  { key: "remark", label: "Remark", render: (r) => r.remark, getValue: (r) => r.remark, defaultHidden: true },
];
const rows: Row[] = [{ id: 1, no: "SO-1", customer: "Tan", remark: "fragile" }];

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});
afterEach(cleanup);

describe("DataTable legacyGridKey", () => {
  const headers = () => screen.getAllByRole("columnheader").map((h) => String(h.textContent).trim());

  it("opens with the layout the user left in the DataGrid", () => {
    writeDataGridLayout("old-grid", {
      order: ["remark", "no", "customer"], hidden: ["customer"], widths: {}, pinned: [], groupBy: [], sort: null,
    });
    render(<DataTable tableId="new-table" legacyGridKey="old-grid" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(headers()).toEqual(["Remark", "No"]);
    expect(localStorage.getItem("dt:legacy:new-table")).toBe("1");
  });

  it("never overwrites a layout the user already made on the DataTable", () => {
    writeDataGridLayout("old-grid", {
      order: ["customer", "no"], hidden: [], widths: {}, pinned: [], groupBy: [], sort: null,
    });
    localStorage.setItem("dt:order:new-table", JSON.stringify(["no", "customer"]));
    render(<DataTable tableId="new-table" legacyGridKey="old-grid" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(headers()).toEqual(["No", "Customer"]);
  });
});
