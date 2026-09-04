// The PO line's Remarks box — asserted against the RENDERED DOM, not the source.
//
// WHY THIS FILE EXISTS. Until 2026-09-04 PoLineCard had no remark field at all:
// a case-insensitive grep for `notes` and `remark` over the whole component
// returned nothing. Meanwhile 923 of the 1,117 migrated company-1 purchase-order
// lines already held AutoCount's own Description 2 in
// scm.purchase_order_items.notes (measured on production 2026-09-04) — the
// customer's spec text in the salesperson's own words, with no surface that
// could show it. Owner, 2026-09-04: 「SO line 和 PO line 的 remarks」.
//
// The second test is the one that will actually catch a regression. The box is
// OPT-IN because this card is reused by PurchaseInvoiceDetail,
// PurchaseInvoiceDetailV2 and PurchaseConsignmentOrderDetail, and each of those
// parents ENUMERATES the fields it sends on add/update. Flipping the default to
// on would give those screens a box that accepts typing and silently discards it
// on save — worse than no box. So "off unless the parent asked" is a contract,
// not a styling choice, and it is asserted here.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The card's only data hook. Stubbed so the test needs no QueryClientProvider.
vi.mock("../lib/mfg-products-queries", () => ({
  useModelAllowedOptionsByCode: () => ({ data: null }),
}));

import { PoLineCard, emptyPoLine, type PoLineDraft } from "./PoLineCard";

afterEach(cleanup);

const line = (over: Partial<PoLineDraft> = {}): PoLineDraft => ({
  ...emptyPoLine(),
  itemCode: "PC151-01",
  materialName: "Bedframe",
  ...over,
});

const props = (
  draft: PoLineDraft,
  onChange: (patch: Partial<PoLineDraft>) => void,
  showRemarks?: boolean,
) => ({
  index: 0,
  line: draft,
  currency: "MYR",
  supplierId: "",
  bindings: [],
  allSkus: [],
  warehouses: [],
  maint: null,
  fabrics: [],
  specialsPools: { bedframe: [], sofa: [] },
  onChange,
  onPickBinding: () => {},
  onSetVariant: () => {},
  onPendingItemPick: () => {},
  onRemove: () => {},
  showRemarks,
});

describe("the PO line card's Remarks box", () => {
  it("shows the stored note and reports what was typed as `notes`", async () => {
    const onChange = vi.fn();
    render(
      <PoLineCard
        {...props(line({ notes: "col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg" }), onChange, true)}
      />,
    );

    const box = screen.getByPlaceholderText("Type remarks…") as HTMLInputElement;
    // The book's own wording, on screen, where nothing rendered it before.
    expect(box.value).toBe("col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg");

    await userEvent.type(box, "!");
    // The parent is told about `notes` — the column that is NOT regenerated on
    // save and NOT on the AutoCount write-back path (PO_ITEM_COLS omits it).
    expect(onChange).toHaveBeenCalledWith({
      notes: "col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg!",
    });
  });

  it("renders NO box at all unless the parent opted in", () => {
    render(<PoLineCard {...props(line({ notes: "book wording" }), () => {})} />);
    // Not merely hidden — absent. A parent that does not send `notes` must not
    // offer a field that looks like it saves.
    expect(screen.queryByPlaceholderText("Type remarks…")).toBeNull();
    expect(screen.queryByText("Remarks")).toBeNull();
  });
});
