import { describe, expect, it } from "vitest";
import { applySoListMrpEnrichment, type SoListMrpEnrichment } from "./soListEnrichment";
import { poCellChips } from "./soPoChips";

/* The SO list paints with the SHIPPED chips + stored-status placeholders the
   list endpoint returns, then the deferred enrichment fetch fills the READY
   chips and the MRP-corrected readiness/planning. These pin that two-phase
   behaviour on the shared overlay both surfaces use. */

type Row = {
  doc_no: string;
  source_po_union?: string[] | null;
  source_po_adj?: boolean;
  stock_remark?: string;
  is_main_ready?: boolean | null;
  planning_state?: string | null;
};

const firstPaint: Row = {
  doc_no: "SO-1",
  source_po_union: ["PO-B", "PO-A"], // SHIPPED arm only, from the list endpoint
  source_po_adj: false,
  stock_remark: "", // stored-status placeholder (nothing ready yet)
  is_main_ready: false,
  planning_state: "PENDING_DELIVERY",
};

describe("applySoListMrpEnrichment", () => {
  it("returns the row unchanged before the endpoint resolves", () => {
    const out = applySoListMrpEnrichment(firstPaint, undefined);
    expect(out).toBe(firstPaint); // same reference — no churn
    // The PO cell shows only the shipped chips at first paint.
    expect(poCellChips(out).source).toEqual(["PO-B", "PO-A"]);
  });

  it("merges the READY chips into the PO cell once the endpoint resolves", () => {
    const enrichment: SoListMrpEnrichment = {
      sourcePoReady: ["PO-C", "PO-A"], // PO-A overlaps shipped; PO-C is new
      sourcePoAdj: true,
      stockRemark: "READY",
      isMainReady: true,
      planningState: "PENDING_SCHEDULE",
    };
    const out = applySoListMrpEnrichment(firstPaint, enrichment);

    // Sorted set union of shipped ∪ ready (no PO-A dup), numeric-aware order —
    // the same order the backend produced when it unioned inline.
    expect(out.source_po_union).toEqual(["PO-A", "PO-B", "PO-C"]);
    expect(poCellChips(out).source).toEqual(["PO-A", "PO-B", "PO-C"]);
    // adj ORs in from the READY arm.
    expect(out.source_po_adj).toBe(true);
    // Readiness / planning are replaced with the MRP-corrected values.
    expect(out.stock_remark).toBe("READY");
    expect(out.is_main_ready).toBe(true);
    expect(out.planning_state).toBe("PENDING_SCHEDULE");
    // First-paint row is untouched (pure overlay).
    expect(firstPaint.stock_remark).toBe("");
  });

  it("keeps the shipped adj flag when the READY arm has none", () => {
    const shippedAdj: Row = { ...firstPaint, source_po_adj: true };
    const out = applySoListMrpEnrichment(shippedAdj, {
      sourcePoReady: [], sourcePoAdj: false,
      stockRemark: "", isMainReady: false, planningState: "PENDING_DELIVERY",
    });
    expect(out.source_po_adj).toBe(true);
  });
});
