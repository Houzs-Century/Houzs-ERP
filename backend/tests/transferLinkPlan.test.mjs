/* The resolver that decides which ERP row a migrated line was raised from.
 *
 * These are the same planted cases the runner refuses on, run here so they gate
 * a PR as well as a dispatch. The two that matter most are the REFUSALS: a
 * blank beats a wrong link, and a resolver that quietly took the first
 * candidate would pass every other case in this file.
 */
import { describe, it, expect } from "vitest";
import {
  resolveOne, runSelfTest, selfTestCases, tally, OUTCOMES, IS_WRITE, IS_REFUSAL,
} from "../scripts/lib/transfer-link-plan.mjs";

describe("transfer-link-plan", () => {
  it("passes every planted case", () => {
    expect(runSelfTest()).toEqual([]);
  });

  for (const c of selfTestCases()) {
    it(c.name, () => {
      expect(resolveOne(c.child, c.parents).outcome).toBe(c.want);
    });
  }

  it("REFUSES rather than taking the first candidate when the item code does not separate", () => {
    /* This is the mutation the module was proved RED against: dropping the
       refusal and falling back to `rows[0]` turns both of these into `link`. */
    const parents = [
      { id: "p1", itemCode: "9058-1A(LHF)", docNo: "GR-005045" },
      { id: "p2", itemCode: "9058-1A(LHF)", docNo: "GR-005045" },
    ];
    const two = resolveOne(
      { id: "c", itemCode: "9058-1A(LHF)", currentParentId: null, bookSourceLineKey: "868276" }, parents);
    expect(two.outcome).toBe("ambiguous");
    expect(two.parentId).toBeNull();

    const none = resolveOne(
      { id: "c", itemCode: "9058-CNR", currentParentId: null, bookSourceLineKey: "868276" }, parents);
    expect(none.outcome).toBe("ambiguous");
    expect(none.parentId).toBeNull();
  });

  it("never returns a parent id on a refusal", () => {
    for (const c of selfTestCases()) {
      const r = resolveOne(c.child, c.parents);
      if (IS_REFUSAL.has(r.outcome)) expect(r.parentId).toBeNull();
      if (IS_WRITE.has(r.outcome)) expect(r.parentId).toBeTruthy();
    }
  });

  it("the outcome sets partition, so no row is counted in two columns", () => {
    for (const o of OUTCOMES) expect(IS_WRITE.has(o) && IS_REFUSAL.has(o)).toBe(false);
    for (const o of [...IS_WRITE, ...IS_REFUSAL]) expect(OUTCOMES).toContain(o);
  });

  it("tallies every declared outcome, including the ones with no rows", () => {
    const t = tally([]);
    expect(Object.keys(t).sort()).toEqual([...OUTCOMES].sort());
    for (const v of Object.values(t)) expect(v).toBe(0);
  });
});
