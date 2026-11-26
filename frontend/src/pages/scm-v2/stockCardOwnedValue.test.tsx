import { cleanup, render, screen } from "@testing-library/react";
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

const LOTS = [
  {
    id: "l1", warehouse_id: "w1", warehouse_code: "KL", item_code: "AKEMI-Q",
    product_name: "AKEMI Queen", qty_received: 2, qty_remaining: 2,
    unit_cost_sen: 50000, received_at: "2026-08-01T00:00:00Z",
    source_doc_type: "GRN", source_doc_no: "2990-GRN-2607-023", is_consignment: false,
  },
  {
    id: "l2", warehouse_id: "w1", warehouse_code: "KL", item_code: "AKEMI-Q",
    product_name: "AKEMI Queen", qty_received: 4, qty_remaining: 4,
    unit_cost_sen: 40000, received_at: "2026-08-02T00:00:00Z",
    source_doc_type: "PC_RECEIVE", source_doc_no: "2990-PCR-2606-001", is_consignment: true,
  },
];

const mount = () => {
  lots.mockReturnValue(q(LOTS));
  movements.mockReturnValue(q([]));
  breakdown.mockReturnValue(q({ balances: [] }));
  warehouses.mockReturnValue(q([{ id: "w1", code: "KL", name: "KL WAREHOUSE" }]));
  return render(
    <MemoryRouter initialEntries={["/scm/inventory/stock-card/AKEMI-Q"]}>
      <StockCard />
    </MemoryRouter>,
  );
};

describe("Stock Card value stat", () => {
  it("prints the OWNED value and never the consignment lots", () => {
    mount();
    expect(screen.getAllByText(/RM 1,000\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2,600\.00/)).toBeNull();
  });

  it("labels the stat as OWNED, so the number cannot be read as everything", () => {
    mount();
    expect(screen.getByText(/Owned Value/i)).toBeTruthy();
  });

  it("still SHOWS the consignment units, as quantity that is not ours", () => {
    mount();
    expect(screen.getByText(/Consignment \(not owned\)/i)).toBeTruthy();
    expect(screen.getByText(/4 units/i)).toBeTruthy();
  });
});
