import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DataTable, type Column, type DataTableChildRow } from "./DataTable";

type Order = { id: string; name: string; customer: string; qty: number };

const orders: Order[] = [{ id: "SO-1", name: "Sofa set", customer: "Lim", qty: 3 }];

const childRows = (): DataTableChildRow[] => [
  { key: "line-1", cells: { name: "Module A", qty: 1, supplier: "Hookka" } },
  { key: "caption", cells: {}, caption: "Accessories" },
];

function columnsWith(overrides: Partial<Record<string, Partial<Column<Order>>>>): Column<Order>[] {
  const base: Column<Order>[] = [
    { key: "name", label: "Name", render: (order) => order.name },
    { key: "customer", label: "Customer", render: (order) => order.customer },
    { key: "qty", label: "Qty", render: (order) => order.qty },
    { key: "supplier", label: "Supplier", render: () => "Hookka" },
  ];
  return base.map((column) => ({ ...column, ...overrides[column.key] }));
}

function renderTable(columns: Column<Order>[]) {
  return render(
    <DataTable
      tableId="expanded-child-rows"
      rows={orders}
      columns={columns}
      getRowKey={(order) => order.id}
      expandable={{ childRows, expandedIds: new Set(["SO-1"]), onExpandedChange: () => undefined }}
    />,
  );
}

const childCellKeys = (container: HTMLElement): (string | null)[] => {
  const childRow = container.querySelector("tbody tr:not([data-vrow])");
  return [...(childRow?.querySelectorAll("td[data-col-key]") ?? [])].map((cell) => cell.getAttribute("data-col-key"));
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("DataTable childRows", () => {
  it("draws each child cell under the parent column of the same key, in column order", () => {
    const { container } = renderTable(columnsWith({}));

    expect(childCellKeys(container)).toEqual(["name", "customer", "qty", "supplier"]);
    const cellText = (key: string) =>
      container.querySelector(`tbody tr:not([data-vrow]) td[data-col-key="${key}"]`)?.textContent;
    expect(cellText("name")).toBe("Module A");
    expect(cellText("customer")).toBe("");
    expect(cellText("supplier")).toBe("Hookka");
  });

  it("drops a hidden column from the child rows too", () => {
    const { container } = renderTable(columnsWith({ customer: { defaultHidden: true } }));

    expect(childCellKeys(container)).toEqual(["name", "qty", "supplier"]);
  });

  it("keeps a canHide=false column on screen even when a layout hides it", () => {
    const { container } = renderTable(columnsWith({ supplier: { defaultHidden: true, canHide: false } }));

    expect(childCellKeys(container)).toContain("supplier");
  });

  it("renders a caption child row as one full-width cell", () => {
    const { getByText } = renderTable(columnsWith({}));

    const captionCell = getByText("Accessories").closest("td");
    expect(captionCell?.colSpan).toBeGreaterThan(4);
  });
});
