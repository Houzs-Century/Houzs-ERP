import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DataTable, type Column } from "./DataTable";

/* Owner 2026-09-25: an empty cell reads as a dash everywhere; a header can
   say what its column means. */

type Row = { id: string; party: string; ref: string | null };
const rows: Row[] = [
  { id: "a", party: "Alpha", ref: "PO-1" },
  { id: "b", party: "Bravo", ref: null },
];
const columns: Column<Row>[] = [
  { key: "party", label: "Party", render: (r) => r.party, getValue: (r) => r.party },
  { key: "ref", label: "Customer ref", description: "The customer's own PO number", render: (r) => r.ref, getValue: (r) => r.ref ?? "" },
];

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
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

describe("DataTable cells", () => {
  it("draws a dash where a cell renders nothing", () => {
    render(<DataTable tableId="cells-dash" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const cell = document.querySelector('tr[data-rowkey="b"] td[data-col-key="ref"]')!;
    expect(cell.textContent).toBe("—");
  });

  it("shows a column's description when its header is hovered", () => {
    render(<DataTable tableId="cells-desc" columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    expect(screen.getByTitle("The customer's own PO number").textContent).toContain("Customer Ref");
  });
});
