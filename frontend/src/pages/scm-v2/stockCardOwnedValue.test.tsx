/* The desktop Stock Card valued goods we do not own — and contradicted itself
 * on the same screen.
 *
 * Consignment stock sits in our warehouse and belongs to the supplier until it
 * sells. It is QUANTITY on hand; it is not our money. The page's stat header
 * summed `qty_remaining x unit_cost_sen` over every open lot and printed the
 * total as "FIFO Value", while the per-warehouse table directly underneath —
 * fed by /breakdown/:itemCode, which has skipped consignment lots since
 * BUG-HISTORY 2026-07-25 — excluded exactly what the stat included. Mobile has
 * always shown "Owned value" plus a separate "Consignment (not owned)" line.
 *
 * These mount the REAL page with only its data hooks faked, and assert what the
 * operator SEES. The fixture is deliberately arithmetic that cannot be reached
 * two ways: owned 2 x RM 500 = RM 1,000, consignment 4 x RM 400 = RM 1,600.
 * A page that prints RM 2,600 is the bug; a page that prints RM 1,000 and says
 * the other 4 units are not ours is the fix.
 */
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
  // buildStockBreakdown is the SHARED transform this page must now use, so it is
  // imported for real — faking it would make the test agree with itself.
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

/** 2 owned units at RM 500, 4 consignment units at RM 400, one warehouse. */
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
    // RM 1,000.00 — the two GRN units. Not RM 2,600.00. (The lot row for l1
    // legitimately prints the same figure as its own remaining value, hence
    // getAllByText; what matters is that the TOTAL is not the all-lots sum.)
    expect(screen.getAllByText(/RM 1,000\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2,600\.00/)).toBeNull();
  });

  it("labels the stat as OWNED, so the number cannot be read as everything", () => {
    // "FIFO Value" named the arithmetic, not the meaning — nothing on the card
    // told the reader that consignment was in it.
    mount();
    expect(screen.getByText(/Owned Value/i)).toBeTruthy();
  });

  it("still SHOWS the consignment units, as quantity that is not ours", () => {
    // Hiding them would be the opposite error: the goods are physically there
    // and the storekeeper counts them. Mobile shows the same two lines.
    mount();
    expect(screen.getByText(/Consignment \(not owned\)/i)).toBeTruthy();
    expect(screen.getByText(/4 units/i)).toBeTruthy();
  });
});
