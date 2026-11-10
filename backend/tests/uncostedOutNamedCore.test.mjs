import { describe, expect, test } from "vitest";
import {
  isConsumingMovement,
  outstandingQty,
  refusalFor,
  planBucketRepair,
  planFingerprint,
  parseNamedRepairEnv,
  xminOf,
  checkWrittenRows,
} from "../scripts/lib/uncosted-out-named-core.mjs";

// scripts/repair-uncosted-out-named.mjs costs uncosted OUTs that
// scm.fn_reconcile_uncosted_out (0154) refuses (non-DO OUTs), by the same steps.
// Everything that decides WHAT it writes is in the pure planner tested here.

const WH = "c05c151e-674a-4aaa-a69b-b9e67d4fbf10";
const KL = "e309c399-697c-4174-967f-ae2c888ad999";
const ITEM = "DUNLOPILLO RELAX SLEEP LUXURY MATT (K)";

const out = (over = {}) => ({
  id: "m-out-1", movement_type: "OUT", qty: 1, consumed: 0,
  created_at: "2026-10-01T00:00:00Z", source_doc_type: "STOCK_TRANSFER",
  source_doc_no: "HC-ST-2610-001", total_cost_sen: 0, unit_cost_sen: 0,
  do_status: null, do_dropship: false, ...over,
});
const lot = (over = {}) => ({
  id: "lot-1", qty_remaining: 1, unit_cost_sen: 222000, received_at: "2026-11-10T00:00:00Z", ...over,
});
const basis = { source: "GRN", docNo: "HC-GRN-1", unitCostSen: 200000, skippedZeroCost: 0 };

describe("movement classification", () => {
  test("OUT and negative ADJUSTMENT consume; positive ADJUSTMENT and IN do not", () => {
    expect(isConsumingMovement("OUT", 1)).toBe(true);
    expect(isConsumingMovement("ADJUSTMENT", -2)).toBe(true);
    expect(isConsumingMovement("ADJUSTMENT", 2)).toBe(false);
    expect(isConsumingMovement("IN", 1)).toBe(false);
  });
  test("outstanding is |qty| minus consumed, never negative", () => {
    expect(outstandingQty({ qty: 3, consumed: 1 })).toBe(2);
    expect(outstandingQty({ qty: -2, consumed: 0 })).toBe(2);
    expect(outstandingQty({ qty: 1, consumed: 1 })).toBe(0);
  });
  test("a cancelled or drop-ship DO is refused; a transfer OUT is not", () => {
    expect(refusalFor(out())).toBeNull();
    expect(refusalFor(out({ source_doc_type: "DO", do_status: "DELIVERED" }))).toBeNull();
    expect(refusalFor(out({ source_doc_type: "DO", do_status: "CANCELLED" }))).toMatch(/CANCELLED/);
    expect(refusalFor(out({ source_doc_type: "DO", do_status: "DELIVERED", do_dropship: true }))).toMatch(/drop-ship/);
    expect(refusalFor(out({ source_doc_type: "DO", do_status: null }))).toMatch(/no longer exists/);
  });
});

describe("planBucketRepair — PG SERVICE shape (one uncosted OUT, one open lot)", () => {
  const plan = planBucketRepair({ consumers: [out()], openLots: [lot()], onHandQty: 0, basis, allowBasis: false });

  test("consumes the lot for the OUT at the lot's cost and ends at qty 0 / value 0", () => {
    expect(plan.status).toBe("repair");
    expect(plan.before).toEqual({ qty: 0, valueSen: 222000 });
    expect(plan.after).toEqual({ qty: 0, valueSen: 0 });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].takes).toEqual([{ lotId: "lot-1", qty: 1, unitCostSen: 222000, costSen: 222000 }]);
    expect(plan.targets[0].newTotalSen).toBe(222000);
    expect(plan.targets[0].newUnitSen).toBe(222000);
    expect(plan.lotsAfter).toEqual([{ id: "lot-1", before: 1, after: 0, unitCostSen: 222000 }]);
    expect(plan.basisUnits).toBe(0);
  });

  test("never uses the basis when a real lot covers the short", () => {
    const withBasis = planBucketRepair({ consumers: [out()], openLots: [lot()], onHandQty: 0, basis, allowBasis: true });
    expect(withBasis.basisUnits).toBe(0);
    expect(withBasis.targets[0].takes[0].lotId).toBe("lot-1");
  });

  test("an already-costed OUT plans nothing (idempotent re-run)", () => {
    const again = planBucketRepair({ consumers: [out({ consumed: 1, total_cost_sen: 222000 })], openLots: [], onHandQty: 0, basis, allowBasis: false });
    expect(again.status).toBe("nothing");
    expect(again.targets).toEqual([]);
  });
});

describe("planBucketRepair — FIFO order and the 0154 cost arithmetic", () => {
  test("oldest short first, oldest lot first, cost added onto what the OUT already had", () => {
    const plan = planBucketRepair({
      consumers: [
        out({ id: "late", qty: 1, created_at: "2026-10-05T00:00:00Z" }),
        out({ id: "early", qty: 3, consumed: 1, total_cost_sen: 1000, created_at: "2026-10-01T00:00:00Z" }),
      ],
      openLots: [
        lot({ id: "new", qty_remaining: 2, unit_cost_sen: 700, received_at: "2026-11-02T00:00:00Z" }),
        lot({ id: "old", qty_remaining: 1, unit_cost_sen: 500, received_at: "2026-11-01T00:00:00Z" }),
      ],
      onHandQty: 0, basis: null, allowBasis: false,
    });
    expect(plan.status).toBe("repair");
    expect(plan.targets.map((t) => t.movementId)).toEqual(["early", "late"]);
    expect(plan.targets[0].takes).toEqual([
      { lotId: "old", qty: 1, unitCostSen: 500, costSen: 500 },
      { lotId: "new", qty: 1, unitCostSen: 700, costSen: 700 },
    ]);
    // (1000 + 1200) / 3 = 733 (integer division, as 0154)
    expect(plan.targets[0].newTotalSen).toBe(2200);
    expect(plan.targets[0].newUnitSen).toBe(733);
    expect(plan.targets[1].takes).toEqual([{ lotId: "new", qty: 1, unitCostSen: 700, costSen: 700 }]);
    expect(plan.after.valueSen).toBe(0);
  });
});

describe("planBucketRepair — KL shape (uncosted OUT, no open lot)", () => {
  test("without ALLOW_BASIS it says so, proposes the basis, and is not repairable", () => {
    const plan = planBucketRepair({ consumers: [out()], openLots: [], onHandQty: 0, basis, allowBasis: false });
    expect(plan.status).toBe("needs-basis");
    expect(plan.basisUnits).toBe(0);
    expect(plan.targets[0].residual).toBe(1);
    expect(plan.reasons.join(" ")).toMatch(/proposed: cost them at the reference basis \(GRN HC-GRN-1\)/);
  });
  test("with ALLOW_BASIS it costs the residual from a seeded basis lot", () => {
    const plan = planBucketRepair({ consumers: [out()], openLots: [], onHandQty: 0, basis, allowBasis: true });
    expect(plan.status).toBe("repair");
    expect(plan.basisUnits).toBe(1);
    expect(plan.targets[0].takes).toEqual([{ lotId: "BASIS", qty: 1, unitCostSen: 200000, costSen: 200000 }]);
    expect(plan.after).toEqual({ qty: 0, valueSen: 0 });
  });
  test("with ALLOW_BASIS but no honest basis it refuses to fabricate", () => {
    const plan = planBucketRepair({ consumers: [out()], openLots: [], onHandQty: 0, basis: { source: null, skippedZeroCost: 2 }, allowBasis: true });
    expect(plan.status).toBe("needs-basis");
    expect(plan.basisUnits).toBe(0);
    expect(plan.reasons.join(" ")).toMatch(/no honest basis/);
  });
});

describe("planBucketRepair — refusals", () => {
  test("a cancelled-DO short refuses the whole warehouse", () => {
    const plan = planBucketRepair({
      consumers: [out({ source_doc_type: "DO", source_doc_no: "HC-DO-1", do_status: "CANCELLED" })],
      openLots: [], onHandQty: 0, basis, allowBasis: true,
    });
    expect(plan.status).toBe("refused");
    expect(plan.refused).toHaveLength(1);
  });
  test("value left on the shelf after the repair is refused (target is 0 / 0)", () => {
    const plan = planBucketRepair({ consumers: [out()], openLots: [lot({ qty_remaining: 2 })], onHandQty: 1, basis, allowBasis: false });
    expect(plan.status).toBe("refused");
    expect(plan.after.valueSen).toBe(222000);
  });
  test("open-lot value with no short OUT is not this repair", () => {
    const plan = planBucketRepair({ consumers: [out({ consumed: 1 })], openLots: [lot()], onHandQty: 1, basis, allowBasis: false });
    expect(plan.status).toBe("refused");
    expect(plan.reasons.join(" ")).toMatch(/no uncosted OUT/);
  });
});

describe("planFingerprint", () => {
  const args = (over = {}) => {
    const plan = planBucketRepair({ consumers: [out()], openLots: [lot()], onHandQty: 0, basis, allowBasis: false, ...over });
    return { companyId: 1, warehouseId: WH, itemCode: ITEM, variantKey: "", plan, basis };
  };
  test("is stable for the same state and 12 hex characters", () => {
    expect(planFingerprint(args())).toBe(planFingerprint(args()));
    expect(planFingerprint(args())).toMatch(/^[0-9a-f]{12}$/);
  });
  test("changes when the lot cost, the lot, or the warehouse changes", () => {
    const h = planFingerprint(args());
    expect(planFingerprint(args({ openLots: [lot({ unit_cost_sen: 222001 })] }))).not.toBe(h);
    expect(planFingerprint(args({ openLots: [lot({ id: "lot-2" })] }))).not.toBe(h);
    expect(planFingerprint({ ...args(), warehouseId: KL })).not.toBe(h);
  });
});

describe("parseNamedRepairEnv", () => {
  test("accepts the owner's case", () => {
    const c = parseNamedRepairEnv({ COMPANY_ID: "1", ITEM_CODE: ITEM, WAREHOUSE_IDS: `${WH},${KL.toUpperCase()}`, ALLOW_BASIS_WAREHOUSE_IDS: KL, PLAN_HASHES: "0123456789ab" });
    expect(c.errors).toEqual([]);
    expect(c.companyId).toBe(1);
    expect(c.itemCode).toBe(ITEM);
    expect(c.variantKey).toBe("");
    expect(c.warehouseIds).toEqual([WH, KL]);
    expect([...c.allowBasis]).toEqual([KL]);
    expect([...c.planHashes]).toEqual(["0123456789ab"]);
  });
  test("reports every missing or malformed input", () => {
    const c = parseNamedRepairEnv({ WAREHOUSE_IDS: "not-a-uuid", ALLOW_BASIS_WAREHOUSE_IDS: KL, PLAN_HASHES: "xyz" });
    expect(c.errors.join("\n")).toMatch(/COMPANY_ID/);
    expect(c.errors.join("\n")).toMatch(/ITEM_CODE/);
    expect(c.errors.join("\n")).toMatch(/not a uuid/);
    expect(c.errors.join("\n")).toMatch(/not one of WAREHOUSE_IDS/);
    expect(c.errors.join("\n")).toMatch(/plan hash/);
  });
});

describe("verification helpers", () => {
  test("xminOf folds the 64-bit xact id to the 32-bit xid", () => {
    expect(xminOf("4294967296")).toBe("0");
    expect(xminOf(String(3n * 4294967296n + 1234n))).toBe("1234");
  });
  test("checkWrittenRows passes only for exactly the planned rows of this item", () => {
    const expected = { lot: ["lot-1"], consumption: ["c-1"], movement: ["m-out-1"] };
    const row = (t, id, over = {}) => ({ t, id, item_code: ITEM, warehouse_id: WH, company_id: 1, ...over });
    const exact = [row("lot", "lot-1"), row("consumption", "c-1"), row("movement", "m-out-1")];
    expect(checkWrittenRows({ written: exact, expected, companyId: 1, warehouseId: WH, itemCode: ITEM })).toEqual([]);
    const extra = [...exact, row("lot", "lot-9", { item_code: "OTHER" })];
    const p = checkWrittenRows({ written: extra, expected, companyId: 1, warehouseId: WH, itemCode: ITEM });
    expect(p.join("\n")).toMatch(/lot-9 is item "OTHER"/);
    expect(p.join("\n")).toMatch(/lot lot-9 was written but is not in the plan/);
    const missing = checkWrittenRows({ written: exact.slice(1), expected, companyId: 1, warehouseId: WH, itemCode: ITEM });
    expect(missing.join("\n")).toMatch(/lot lot-1 is in the plan but does not carry/);
  });
});
