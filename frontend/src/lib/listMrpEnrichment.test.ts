import { describe, expect, it } from "vitest";
import {
  applyListMrpEnrichment,
  LIST_MRP_DERIVED_FIELDS,
  type EnrichableMrpRow,
  type ListMrpEnrichment,
} from "./listMrpEnrichment";

/* The PO and GRN lists paint WITHOUT the four MRP-derived columns (the list
   endpoints omit them — resolving them ran a company-wide computeMrp on the
   critical path), then the deferred enrichment fetch fills them. These pin that
   two-phase behaviour on the shared overlay both lists apply. */

const firstPaint: EnrichableMrpRow = { id: "po-1" };

const enrichment: ListMrpEnrichment = {
  assigned_sos: [{ soDocNo: "SO-1" }] as ListMrpEnrichment["assigned_sos"],
  assigned_so_linked: true,
  assigned_so_provenance: [{ soDocNo: "SO-2" }] as ListMrpEnrichment["assigned_so_provenance"],
  delivered_dos: [{ doNo: "DO-1", qty: 3 }],
};

describe("applyListMrpEnrichment", () => {
  it("returns the row unchanged before the endpoint resolves", () => {
    const out = applyListMrpEnrichment(firstPaint, undefined);
    expect(out).toBe(firstPaint); // same reference — no churn
    expect(out.assigned_sos).toBeUndefined();
    expect(out.delivered_dos).toBeUndefined();
  });

  it("fills all four columns once the endpoint resolves", () => {
    const out = applyListMrpEnrichment(firstPaint, enrichment);
    expect(out.assigned_sos).toEqual([{ soDocNo: "SO-1" }]);
    expect(out.assigned_so_linked).toBe(true);
    expect(out.assigned_so_provenance).toEqual([{ soDocNo: "SO-2" }]);
    expect(out.delivered_dos).toEqual([{ doNo: "DO-1", qty: 3 }]);
    expect(firstPaint.assigned_sos).toBeUndefined(); // pure overlay
  });

  it("REPLACES columns wholesale — there is no inline arm to preserve", () => {
    const stale: EnrichableMrpRow = {
      id: "po-1",
      assigned_sos: [{ soDocNo: "OLD" }] as EnrichableMrpRow["assigned_sos"],
      delivered_dos: [{ doNo: "OLD-DO", qty: 9 }],
    };
    const out = applyListMrpEnrichment(stale, enrichment);
    expect(out.assigned_sos).toEqual([{ soDocNo: "SO-1" }]);
    expect(out.delivered_dos).toEqual([{ doNo: "DO-1", qty: 3 }]);
  });
});

/* C16 guard. Its backend twins are LIST_MRP_ENRICHMENT_KEYS in
   backend/src/scm/routes/mfg-purchase-orders-list-enrichment.ts and
   grns-list-enrichment.ts — the literal arrays must stay equal, so a new
   MRP-derived list field added on only one side fails CI. */
describe("applyListMrpEnrichment — C16 field-set parity", () => {
  it("heals EXACTLY the four MRP-derived fields — no more, no less", () => {
    expect([...LIST_MRP_DERIVED_FIELDS].sort()).toEqual(
      ["assigned_so_linked", "assigned_so_provenance", "assigned_sos", "delivered_dos"].sort(),
    );

    const before: EnrichableMrpRow = { id: "po-1" };
    const after = applyListMrpEnrichment(before, enrichment);
    const changed = (Object.keys(after) as Array<keyof EnrichableMrpRow>).filter(
      (k) => k !== "id" && after[k] !== undefined,
    );
    expect(changed.sort()).toEqual([...LIST_MRP_DERIVED_FIELDS].sort());
  });
});
