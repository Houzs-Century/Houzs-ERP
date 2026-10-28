/* The Stock Card MOVEMENTS filter row, mounted on the real page (owner
 * 2026-09-18). The pure predicate is covered in stockMovementFilter.test.ts;
 * this asserts the wiring the operator actually touches — the Type chips, the
 * Source-doc box, the "Showing X of N" count and the Clear control — by
 * rendering StockCard with a small ledger and only its data hooks faked.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { lots, movements, breakdown, warehouses } = vi.hoisted(() => ({
  lots: vi.fn(),
  movements: vi.fn(),
  breakdown: vi.fn(),
  warehouses: vi.fn(),
}));

vi.mock("../../vendor/scm/lib/inventory-queries", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useInventoryLots: lots,
  useInventoryMovements: movements,
  useInventoryProductBreakdown: breakdown,
  useWarehouses: warehouses,
}));

import { StockCard } from "./StockCard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const q = (data: unknown) => ({ data, isLoading: false, error: null });

const mv = (over: Record<string, unknown>) => ({
  id: "x", movement_type: "IN", warehouse_id: "w1", item_code: "AKEMI-Q",
  product_name: "AKEMI Queen", qty: 1, unit_cost_sen: 0, source_doc_type: "GRN",
  source_doc_id: null, source_doc_no: null, reason_code: null, notes: null,
  performed_by: null, created_at: "2026-08-01T12:00:00Z", ...over,
});

const MOVEMENTS = [
  mv({ id: "m1", movement_type: "IN", warehouse_id: "w1", source_doc_no: "HC-GRN-0001", created_at: "2026-08-20T12:00:00Z" }),
  mv({ id: "m2", movement_type: "OUT", warehouse_id: "w2", source_doc_no: "HC-DO-0007", created_at: "2026-08-10T12:00:00Z" }),
  mv({ id: "m3", movement_type: "IN", warehouse_id: "w1", source_doc_no: "AC-BAL-0003", created_at: "2026-08-01T12:00:00Z" }),
];

const mount = () => {
  lots.mockReturnValue(q([]));
  movements.mockReturnValue(q(MOVEMENTS));
  breakdown.mockReturnValue(q({ balances: [] }));
  warehouses.mockReturnValue(q([
    { id: "w1", code: "KL WAREHOUSE", name: "KL WAREHOUSE" },
    { id: "w2", code: "PG WAREHOUSE", name: "PG WAREHOUSE" },
  ]));
  return render(
    <MemoryRouter initialEntries={["/scm/inventory/stock-card/AKEMI-Q"]}>
      <StockCard />
    </MemoryRouter>,
  );
};

describe("Stock Card movements filter", () => {
  it("shows the total count and no clear button before any filter", () => {
    mount();
    expect(screen.getByText("3 movements")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Clear filters/i })).toBeNull();
  });

  it("filters by Type and reports Showing X of N", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "OUT" }));
    expect(screen.getByText("Showing 1 of 3")).toBeTruthy();
    // Source-doc numbers are unique to the movement rows, so their presence maps
    // one-to-one to which rows survived the filter.
    expect(screen.getByText("HC-DO-0007")).toBeTruthy();
    expect(screen.queryByText("HC-GRN-0001")).toBeNull();
  });

  it("filters by Source doc substring", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Filter by source document"), {
      target: { value: "hc-" },
    });
    expect(screen.getByText("Showing 2 of 3")).toBeTruthy();
    expect(screen.queryByText("AC-BAL-0003")).toBeNull();
  });

  it("Clear filters restores the full ledger", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "IN" }));
    expect(screen.getByText("Showing 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/i }));
    expect(screen.getByText("3 movements")).toBeTruthy();
  });
});
