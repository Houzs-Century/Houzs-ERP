import { describe, expect, it } from "vitest";
import {
  applyPiListMrpEnrichment,
  PI_MRP_DERIVED_LIST_FIELDS,
  type EnrichablePiRow,
  type PiListMrpEnrichment,
} from "./piListEnrichment";

/* The PI list paints WITHOUT the four MRP-derived columns (the list endpoint
   omits them — resolving them ran a company-wide computeMrp on the critical
   path), then the deferred enrichment fetch fills them. These pin that two-phase
   behaviour on the overlay the list applies. */

const firstPaint: EnrichablePiRow = {
  id: "pi-1",
  // The four MRP-derived columns are ABSENT at first paint (omit not blank).
};

const enrichment: PiListMrpEnrichment = {
  assigned_sos: [{ soDocNo: "SO-1" }] as PiListMrpEnrichment["assigned_sos"],
  assigned_so_linked: true,
  assigned_so_provenance: [{ soDocNo: "SO-2" }] as PiListMrpEnrichment["assigned_so_provenance"],
  delivered_dos: [{ doNo: "DO-1", qty: 3 }],
};

describe("applyPiListMrpEnrichment", () => {
  it("returns the row unchanged before the endpoint resolves", () => {
    const out = applyPiListMrpEnrichment(firstPaint, undefined);
    expect(out).toBe(firstPaint); // same reference — no churn
    expect(out.assigned_sos).toBeUndefined();
    expect(out.delivered_dos).toBeUndefined();
  });

  it("fills all four columns once the endpoint resolves", () => {
    const out = applyPiListMrpEnrichment(firstPaint, enrichment);
    expect(out.assigned_sos).toEqual([{ soDocNo: "SO-1" }]);
    expect(out.assigned_so_linked).toBe(true);
    expect(out.assigned_so_provenance).toEqual([{ soDocNo: "SO-2" }]);
    expect(out.delivered_dos).toEqual([{ doNo: "DO-1", qty: 3 }]);
    // First-paint row is untouched (pure overlay).
    expect(firstPaint.assigned_sos).toBeUndefined();
  });

  it("REPLACES columns wholesale — there is no inline arm to preserve", () => {
    const stale: EnrichablePiRow = {
      id: "pi-1",
      assigned_sos: [{ soDocNo: "OLD" }] as EnrichablePiRow["assigned_sos"],
      assigned_so_linked: false,
      delivered_dos: [{ doNo: "OLD-DO", qty: 9 }],
    };
    const out = applyPiListMrpEnrichment(stale, enrichment);
    expect(out.assigned_sos).toEqual([{ soDocNo: "SO-1" }]);
    expect(out.delivered_dos).toEqual([{ doNo: "DO-1", qty: 3 }]);
  });
});

/* C16 guard (Hookka rule: pin the projection's whole key set in a test, in the
   same commit as the split). Its backend twin is PI_LIST_MRP_ENRICHMENT_KEYS in
   backend/src/scm/lib/pi-assigned-sos.ts — the two literal arrays must stay
   equal, so a new MRP-derived PI-list field added on only one side fails CI. */
describe("applyPiListMrpEnrichment — C16 field-set parity", () => {
  it("heals EXACTLY the four MRP-derived fields — no more, no less", () => {
    expect([...PI_MRP_DERIVED_LIST_FIELDS].sort()).toEqual(
      ["assigned_so_linked", "assigned_so_provenance", "assigned_sos", "delivered_dos"].sort(),
    );

    const before: EnrichablePiRow = { id: "pi-1" };
    const after = applyPiListMrpEnrichment(before, enrichment);
    const changed = (Object.keys(after) as Array<keyof EnrichablePiRow>).filter(
      (k) => k !== "id" && after[k] !== undefined,
    );
    expect(changed.sort()).toEqual([...PI_MRP_DERIVED_LIST_FIELDS].sort());
  });
});
