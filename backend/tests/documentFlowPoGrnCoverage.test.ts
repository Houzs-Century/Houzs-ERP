import { describe, expect, test } from "vitest";
import { derivePoGrnCoverage } from "../src/scm/routes/document-flow";

// The Relationship Map used to hang a PO's GRN nodes off grns.purchase_order_id
// (the header FK). A supplier multi-receive (grns POST /from-po-items) bundles
// picks across many POs into ONE GRN headed by the FIRST PO only, so the receipt
// was invisible on every OTHER source PO — it looked received with no GRN. The
// map now derives PO -> GRN coverage from the grn_items line link, per (PO, GRN).

describe("derivePoGrnCoverage — a PO's GRNs come from its lines, not the header FK", () => {
  test("a GRN whose header names another PO still covers the PO whose LINE it received", () => {
    // PO-052 line (qty 2) received 2 units by GRN g057 — whose HEADER is PO-933.
    const poItemQty = new Map([["q052", { poId: "po052", qty: 2 }]]);
    const grnLines = [{ grn_id: "g057", purchase_order_item_id: "q052", qty: 2 }];
    const cov = derivePoGrnCoverage(poItemQty, grnLines);
    expect(cov.get("po052|g057")).toEqual({ childQty: 2, parentQty: 2 });
  });

  test("one GRN receiving lines from several POs yields one entry per PO, each with only that PO's qty", () => {
    const poItemQty = new Map([
      ["a1", { poId: "poA", qty: 1 }],
      ["b1", { poId: "poB", qty: 3 }],
    ]);
    const grnLines = [
      { grn_id: "g1", purchase_order_item_id: "a1", qty: 1 },
      { grn_id: "g1", purchase_order_item_id: "b1", qty: 2 },
    ];
    const cov = derivePoGrnCoverage(poItemQty, grnLines);
    expect(cov.get("poA|g1")).toEqual({ childQty: 1, parentQty: 1 }); // full
    expect(cov.get("poB|g1")).toEqual({ childQty: 2, parentQty: 3 }); // partial: 2 of 3
  });

  test("aggregates multiple grn lines per (PO, GRN); ignores an unknown line, a null line and a null grn", () => {
    const poItemQty = new Map([
      ["x1", { poId: "poX", qty: 5 }],
      ["x2", { poId: "poX", qty: 5 }],
    ]);
    const grnLines = [
      { grn_id: "g9", purchase_order_item_id: "x1", qty: 2 },
      { grn_id: "g9", purchase_order_item_id: "x2", qty: 1 },
      { grn_id: "g9", purchase_order_item_id: "unknown", qty: 9 }, // not a line of any PO in scope
      { grn_id: "", purchase_order_item_id: "x1", qty: 1 }, // no grn
      { grn_id: "g9", purchase_order_item_id: null, qty: 1 }, // no line
    ];
    const cov = derivePoGrnCoverage(poItemQty, grnLines);
    expect(cov.size).toBe(1);
    expect(cov.get("poX|g9")).toEqual({ childQty: 3, parentQty: 10 });
  });

  test("no receiving line yields no coverage (the header FK draws its own fallback edge)", () => {
    const cov = derivePoGrnCoverage(new Map([["a1", { poId: "poA", qty: 1 }]]), []);
    expect(cov.size).toBe(0);
  });
});
