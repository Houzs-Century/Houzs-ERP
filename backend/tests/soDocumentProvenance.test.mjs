/* The provenance predicate, against the INTENDED answers written out by hand.
 *
 * Written RED first, against a stub that answered MIGRATED for everything —
 * which is what the reconcile effectively assumes today. Two of the seven
 * planted cases failed, and they are the two the class exists for. A test that
 * only re-states what the current code does would have passed against that stub
 * and proved nothing.
 */
import { describe, expect, it } from "vitest";

import {
  ERP_RAISED, MIGRATED, PROVENANCES, UNLINKED, provenanceOf, runSelfTest, selfTestCases,
} from "../scripts/lib/so-document-provenance.mjs";

describe("provenanceOf", () => {
  it("answers every planted case", () => {
    expect(runSelfTest()).toEqual([]);
  });

  it("only ever answers a declared provenance", () => {
    for (const c of selfTestCases()) expect(PROVENANCES).toContain(provenanceOf(c.row));
  });

  /* THE DOCUMENTS THIS WAS BUILT FOR, by name and by their real numbers, so a
     future change that quietly re-answers them fails here rather than in a
     tally somebody reads once a day. */
  it("separates the three ERP-raised orders on run 34303762513 from the migrated ones", () => {
    const erpRaised = ["HC-SO-2609-002", "HC-SO-2609-005", "HC-SO-2609-006"];
    for (const d of erpRaised) {
      expect(provenanceOf({ docNo: d, linkedAcDocNo: d })).toBe(ERP_RAISED);
    }
    /* Every migrated document on that same run's DIFFER list. */
    const migrated = [
      "HC-SO-000870", "HC-SO-007293", "HC-SO-010209", "HC-SO-010284", "HC-SO-010287",
      "HC-SO-010955", "HC-SO-011160", "HC-SO-011207", "HC-SO-012128", "HC-SO-012729",
      "HC-SO-013103", "HC-SO-013258", "HC-SO-013310", "HC-SO-013322", "HC-SO-013389",
      "HC-SO-013434",
    ];
    for (const d of migrated) {
      expect(provenanceOf({ docNo: d, linkedAcDocNo: d.replace(/^HC-/, "") })).toBe(MIGRATED);
    }
  });

  /* THE WIDENING THIS MUST REFUSE. If the predicate is ever loosened to "the
     book number looks like ours" — a prefix strip, a suffix match, a
     normalisation that drops `HC-` — every migrated document in the corpus
     becomes ERP-raised and the whole cutover verdict empties itself. */
  it("refuses to call a migrated document ERP-raised however similar the numbers look", () => {
    expect(provenanceOf({ docNo: "HC-SO-013503", linkedAcDocNo: "SO-013503" })).toBe(MIGRATED);
    expect(provenanceOf({ docNo: "HC-SO-2609-002", linkedAcDocNo: "SO-2609-002" })).toBe(MIGRATED);
    expect(provenanceOf({ docNo: "HC-SO-013503", linkedAcDocNo: "SO-0135030" })).toBe(MIGRATED);
  });

  it("says UNLINKED rather than guessing when there is no book number", () => {
    expect(provenanceOf({ docNo: "HC-SO-2609-009", linkedAcDocNo: null })).toBe(UNLINKED);
    expect(provenanceOf({ docNo: "HC-SO-2609-009", linkedAcDocNo: "  " })).toBe(UNLINKED);
    expect(provenanceOf(null)).toBe(UNLINKED);
  });
});
