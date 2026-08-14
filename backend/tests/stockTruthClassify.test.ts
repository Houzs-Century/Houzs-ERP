import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper, no types
import { explainDivergence } from "../scripts/stock-truth-classify.mjs";

/* Every case below is taken from the production run of 2026-08-11 (workflow run
   31451606101) and cross-checked against live AutoCount over read-only ODBC, so
   these are real cells, not invented ones.

   The property under test: a divergence is forgiven ONLY when AutoCount's own
   movement since the cutover accounts for every unit of it. Get this wrong in
   the permissive direction and the check silently stops reporting real missing
   stock — which is the worst defect this instrument could have. */
describe("explainDivergence", () => {
  it("forgives a cell that reconciles exactly to AutoCount trading on", () => {
    // AMN-SOFA PILLOW @ KL: ERP holds the opening balance 130, AutoCount is now
    // 115 having issued 15. Real numbers from the production run.
    const r = explainDivergence({ delta: 15, ac: 115 }, { qty: 130 });
    expect(r.explained).toBe(true);
    expect(r.movedSinceCutover).toBe(15);
    expect(r.unaccounted).toBe(0);
  });

  it("does NOT forgive a cell that is off by even one unit", () => {
    // The whole point. If AutoCount issued 14 but the ERP is 15 higher, one unit
    // is unaccounted for and the cell must stay in the bucket a human reads.
    const r = explainDivergence({ delta: 15, ac: 115 }, { qty: 129 });
    expect(r.explained).toBe(false);
    expect(r.unaccounted).toBe(1);
  });

  it("does NOT forgive a cell the cutover baseline has no row for", () => {
    // Unknown is never treated as fine.
    const r = explainDivergence({ delta: 3, ac: 0 }, undefined);
    expect(r.explained).toBe(false);
    expect(r.movedSinceCutover).toBeNull();
    expect(r.unaccounted).toBe(3);
  });

  it("does NOT forgive stock the ERP gained while AutoCount also issued", () => {
    // ERP wrongly gained 3 AND AutoCount issued 3: delta 6, moved 3. A tolerance
    // would swallow this; the exact test keeps it.
    const r = explainDivergence({ delta: 6, ac: 97 }, { qty: 100 });
    expect(r.explained).toBe(false);
    expect(r.unaccounted).toBe(3);
  });

  it("handles the ERP-LOWER direction, where AutoCount RECEIVED after the cutover", () => {
    // AutoCount received 4 since the cutover, so it is legitimately 4 above the
    // ERP's frozen balance: delta -4, moved -4.
    const r = explainDivergence({ delta: -4, ac: 104 }, { qty: 100 });
    expect(r.explained).toBe(true);
    expect(r.unaccounted).toBe(0);
  });

  it("never reports a zero delta as explained", () => {
    // A cell that agrees is not 'explained divergence'; it is agreement, and it
    // must never be counted into the explained bucket.
    const r = explainDivergence({ delta: 0, ac: 100 }, { qty: 100 });
    expect(r.explained).toBe(false);
  });

  it("counts the real production population both ways", () => {
    /* The two cells that did NOT reconcile on 2026-08-11, alongside three that
       did. Without the baseline every one of these is a divergence (5); with it,
       only 2 survive. That difference IS the fix — a test that passes either way
       would prove nothing. */
    const cells = [
      { delta: 15, ac: 115, base: { qty: 130 } },   // AMN-SOFA PILLOW  — explained
      { delta: 9, ac: 99, base: { qty: 108 } },     // AK- ESSENTIAL BOLSTER — explained
      { delta: 9, ac: 100, base: { qty: 109 } },    // JM-CL JAC WP MP (Q) — explained
      { delta: 3, ac: 8, base: undefined },         // no cutover row — UNEXPLAINED
      { delta: 2, ac: 5, base: { qty: 6 } },        // moved 1, delta 2 — UNEXPLAINED
    ];
    const withBaseline = cells.filter((c) => !explainDivergence(c, c.base).explained);
    const withoutBaseline = cells.filter((c) => !explainDivergence(c, undefined).explained);
    expect(withoutBaseline).toHaveLength(5);  // the old behaviour: everything diverges
    expect(withBaseline).toHaveLength(2);     // the new behaviour: only the real signal
  });
});
