/* Owner 2026-11-10 ("2990 - for dining remark 需要带进 PO remark"): the PO
 * quick-view (the right slide-out from a PO row) must show each DINING line's
 * own Remark in the Line Items area, so the supplier-facing note is visible
 * without opening the full page.
 *
 * The trap this pins: `purchase_order_items.notes` is populated on NON-dining
 * lines too (a sofa / bedframe / mattress line carries its own note), so the
 * panel must key off the server's DINING-gated `dining_remark` — never the raw
 * `notes` — or every sofa note would surface here. The server applies the gate
 * (po-dining-remark.ts); this renders the drawer in isolation with the detail
 * hook faked and asserts the dining remark shows while a non-dining line's note
 * stays hidden. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoItemRow, PoHeaderRow } from "../../vendor/scm/lib/suppliers-queries";

const h = vi.hoisted(() => ({ items: [] as PoItemRow[] }));

vi.mock("../../vendor/scm/lib/suppliers-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/scm/lib/suppliers-queries")>()),
  usePurchaseOrderDetail: () => ({ data: { items: h.items }, isLoading: false, error: null }),
}));

import { DetailDrawer } from "./PurchaseOrdersListV2";

const line = (over: Partial<PoItemRow>): PoItemRow => ({
  id: "l-x",
  purchase_order_id: "po-1",
  binding_id: null,
  material_kind: "mfg_product",
  item_code: "ITEM",
  material_name: "ITEM",
  supplier_sku: null,
  qty: 1,
  unit_price_sen: 100000,
  line_total_sen: 100000,
  received_qty: 0,
  notes: null,
  item_group: "dining",
  variants: {},
  so_drift: null,
  ...over,
});

const row = {
  id: "po-1",
  po_number: "2990-PO-2611-077",
  status: "SUBMITTED",
  po_date: "2026-11-10",
  expected_at: "2026-11-23",
  currency: "MYR",
  supplier_id: "sup-1",
  supplier: { id: "sup-1", code: "400-M001", name: "MAJESTIC CREATION SDN BHD" },
  subtotal_sen: 198000,
  total_sen: 198000,
  items: [],
  transfer_to_grns: [],
} as unknown as PoHeaderRow;

const noop = () => {};
const mount = () =>
  render(
    <DetailDrawer
      row={row}
      onClose={noop}
      onOpenFull={noop}
      onEdit={noop}
      onPrint={noop}
      onCancel={noop}
      onConvertGrn={noop}
    />,
  );

afterEach(cleanup);

describe("PO quick-view: a DINING line shows its Remark", () => {
  it("renders each dining line's own remark in the Line Items area", () => {
    h.items = [
      line({ id: "d-1", item_code: "DINING TABLE TOP", item_group: "dining", notes: "MT-505OV 5.3ft" }),
      line({ id: "d-2", item_code: "DINING CHAIR", item_group: "dining", notes: "7010 DC-LS" }),
    ];
    mount();
    // getByText throws if absent, so these calls are the presence assertions.
    expect(screen.getByText("MT-505OV 5.3ft")).toBeTruthy();
    expect(screen.getByText("7010 DC-LS")).toBeTruthy();
    // Both dining lines show the "Remark" label.
    expect(screen.getAllByText("Remark")).toHaveLength(2);
  });

  it("does NOT surface a non-dining line's own note (the DINING gate holds)", () => {
    // A sofa line carries a `notes` value too, but it is not a dining line, so
    // the panel must stay silent on it.
    h.items = [
      line({ id: "s-1", item_code: "SOFA BOOQIT", item_group: "sofa", notes: "WOOD FRAME NOTE" }),
    ];
    mount();
    expect(screen.queryByText("WOOD FRAME NOTE")).toBeNull();
    expect(screen.queryByText("Remark")).toBeNull();
  });
});
