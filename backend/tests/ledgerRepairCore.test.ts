import { describe, expect, test } from "vitest";
import {
  classifyGrnInboundGap,
  pickCostBasis,
  classifyMovementRelabel,
  projectRelabelledDrift,
} from "../scripts/lib/ledger-repair-core.mjs";

// The 2026-08 ledger-perfection repairs (W2 inbound gap, W3 basis cost, W4
// variant-key relabel) write to the money-critical FIFO ledger, so — exactly
// like doc-ref-repair-core — every decision is a pure function pinned here,
// and the production scripts carry no judgement of their own.

describe("classifyGrnInboundGap (W2) — a missing IN is inserted only when its own sibling proves it", () => {
  const bucket = (over: Record<string, unknown> = {}) => ({
    warehouseId: "wh-1",
    variantKey: "",
    batchNo: "2990-PO-2606-001",
    companyId: 2,
    movQty: 500,
    unitCosts: [12345],
    ...over,
  });

  test("THE WOUND: 501 accepted vs one 500-unit movement plans a 1-unit insert at the sibling's landed cost", () => {
    const v = classifyGrnInboundGap({ productCode: "MATT-X", lineQty: 501, buckets: [bucket()] });
    expect(v.verdict).toBe("insert");
    expect(v.insert).toEqual({
      qty: 1,
      warehouseId: "wh-1",
      variantKey: "",
      batchNo: "2990-PO-2606-001",
      companyId: 2,
      unitCostSen: 12345,
    });
  });

  test("idempotence: after the insert the delta recomputes to zero and the verdict is balanced", () => {
    const v = classifyGrnInboundGap({ productCode: "MATT-X", lineQty: 501, buckets: [bucket({ movQty: 501 })] });
    expect(v.verdict).toBe("balanced");
  });

  test("movements EXCEEDING lines is an over-post, not something an insert can fix", () => {
    expect(classifyGrnInboundGap({ productCode: "P", lineQty: 499, buckets: [bucket()] }).verdict).toBe("over-posted");
  });

  test("no sibling movement means no provable bucket or cost — refused", () => {
    expect(classifyGrnInboundGap({ productCode: "P", lineQty: 3, buckets: [] }).verdict).toBe("no-sibling");
  });

  test("two distinct buckets cannot say which one is short — refused", () => {
    const v = classifyGrnInboundGap({
      productCode: "P",
      lineQty: 10,
      buckets: [bucket({ movQty: 5 }), bucket({ variantKey: "SIZE:K", movQty: 4 })],
    });
    expect(v.verdict).toBe("ambiguous-bucket");
  });

  test("siblings disagreeing on unit cost cannot prove the price — refused", () => {
    const v = classifyGrnInboundGap({
      productCode: "P",
      lineQty: 6,
      buckets: [bucket({ movQty: 5, unitCosts: [100, 200] })],
    });
    expect(v.verdict).toBe("ambiguous-cost");
  });
});

describe("pickCostBasis (W3) — newest GRN landed cost first, PO line cost as fallback, zero is never a basis", () => {
  test("prefers the newest GRN candidate", () => {
    const v = pickCostBasis({
      grnCandidates: [
        { unitCostSen: 55000, docNo: "2990-GRN-2607-004" },
        { unitCostSen: 51000, docNo: "2990-GRN-2605-001" },
      ],
      poCandidates: [{ unitCostSen: 60000, docNo: "2990-PO-2607-001" }],
    });
    expect(v).toMatchObject({ source: "GRN", docNo: "2990-GRN-2607-004", unitCostSen: 55000, skippedZeroCost: 0 });
  });

  test("skips zero-cost GRNs (they are the wound, not a basis) and reports how many it skipped", () => {
    const v = pickCostBasis({
      grnCandidates: [
        { unitCostSen: 0, docNo: "2990-GRN-2607-009" },
        { unitCostSen: 48000, docNo: "2990-GRN-2606-002" },
      ],
    });
    expect(v).toMatchObject({ source: "GRN", docNo: "2990-GRN-2606-002", unitCostSen: 48000, skippedZeroCost: 1 });
  });

  test("falls back to the latest PO line when no GRN carries a cost", () => {
    const v = pickCostBasis({
      grnCandidates: [{ unitCostSen: 0, docNo: "G1" }],
      poCandidates: [{ unitCostSen: 39900, docNo: "2990-PO-2606-011" }],
    });
    expect(v).toMatchObject({ source: "PO", docNo: "2990-PO-2606-011", unitCostSen: 39900, skippedZeroCost: 1 });
  });

  test("no candidate with a cost anywhere refuses — source null, never a fabricated number", () => {
    const v = pickCostBasis({ grnCandidates: [{ unitCostSen: 0 }], poCandidates: [{ unitCostSen: 0 }] });
    expect(v.source).toBeNull();
    expect(v.skippedZeroCost).toBe(2);
  });

  test("no candidates at all also refuses", () => {
    expect(pickCostBasis({}).source).toBeNull();
  });
});

describe("classifyMovementRelabel (W4) — a movement follows the lot its own trail proves, or is left alone", () => {
  test("an OUT whose consumptions all sit under ONE sibling key is relabelled to it", () => {
    const v = classifyMovementRelabel({
      movementId: "m1",
      movementType: "OUT",
      qty: 2,
      variantKey: "COLOUR:GOLD",
      consumptionLotKeys: ["COLOUR:Gold", "COLOUR:Gold"],
    });
    expect(v).toMatchObject({ verdict: "relabel", newKey: "COLOUR:Gold" });
  });

  test("an OUT already matching its lots is consistent — idempotent re-run plans nothing", () => {
    const v = classifyMovementRelabel({
      movementId: "m1",
      movementType: "OUT",
      qty: 2,
      variantKey: "COLOUR:Gold",
      consumptionLotKeys: ["COLOUR:Gold"],
    });
    expect(v.verdict).toBe("consistent");
  });

  test("an OUT that consumed nothing has NO lot evidence — that is W3/retro-cost territory, never a relabel", () => {
    const v = classifyMovementRelabel({ movementId: "m1", movementType: "OUT", qty: 1, variantKey: "K", consumptionLotKeys: [] });
    expect(v.verdict).toBe("no-lot-evidence");
  });

  test("consumptions spanning two lot keys refuse — the trail contradicts itself", () => {
    const v = classifyMovementRelabel({
      movementId: "m1",
      movementType: "OUT",
      qty: 2,
      variantKey: "A",
      consumptionLotKeys: ["B", "C"],
    });
    expect(v).toMatchObject({ verdict: "mixed-lot-keys", lotKeys: ["B", "C"] });
  });

  test("a negative ADJUSTMENT is judged like an OUT (it consumes)", () => {
    const v = classifyMovementRelabel({
      movementId: "m1",
      movementType: "ADJUSTMENT",
      qty: -1,
      variantKey: "A",
      consumptionLotKeys: ["B"],
    });
    expect(v).toMatchObject({ verdict: "relabel", newKey: "B" });
  });

  test("an IN follows the lot it opened (inventory_lots.movement_id)", () => {
    const v = classifyMovementRelabel({ movementId: "m2", movementType: "IN", qty: 5, variantKey: "A", openedLotKey: "B" });
    expect(v).toMatchObject({ verdict: "relabel", newKey: "B" });
  });

  test("an IN whose lot is missing has no evidence — untouched", () => {
    const v = classifyMovementRelabel({ movementId: "m2", movementType: "IN", qty: 5, variantKey: "A" });
    expect(v.verdict).toBe("no-lot-evidence");
  });

  test("a TRANSFER is out of scope — this rule holds no evidence for it", () => {
    const v = classifyMovementRelabel({ movementId: "m3", movementType: "TRANSFER", qty: 1, variantKey: "A" });
    expect(v.verdict).toBe("out-of-scope");
  });

  test("empty variant keys compare as '' (the ledger's COALESCE convention)", () => {
    const v = classifyMovementRelabel({
      movementId: "m4",
      movementType: "OUT",
      qty: 1,
      variantKey: null as unknown as string,
      consumptionLotKeys: [""],
    });
    expect(v.verdict).toBe("consistent");
  });
});

describe("projectRelabelledDrift (W4) — the paired drift closes, and the projection proves it before any write", () => {
  test("THE XAMMAR SHAPE: OUT booked under key A, lot consumed under key B — relabelling the OUT merges the pair to zero drift", () => {
    // Family: IN +5 under B opened lot B (consumed 2 by the mislabelled OUT,
    // so lot B remaining = 3). OUT -2 recorded under A. Buckets read:
    //   A: mov -2, lot 0   (drift -2, the negative bucket)
    //   B: mov +5, lot 3   (drift +2)
    const buckets = new Map([
      ["2::wh::XAM::A", { movQty: -2, lotQty: 0 }],
      ["2::wh::XAM::B", { movQty: 5, lotQty: 3 }],
    ]);
    const after = projectRelabelledDrift(buckets, [
      { fromKey: "2::wh::XAM::A", toKey: "2::wh::XAM::B", signedQty: -2 },
    ]);
    expect(after.get("2::wh::XAM::A")).toEqual({ movQty: 0, lotQty: 0 });
    expect(after.get("2::wh::XAM::B")).toEqual({ movQty: 3, lotQty: 3 });
  });

  test("an IN relabel moves its positive contribution and can close a missing-lot-side split", () => {
    const buckets = new Map([
      ["2::wh::P::A", { movQty: 4, lotQty: 0 }],
      ["2::wh::P::B", { movQty: -4, lotQty: 0 }],
    ]);
    // The IN (+4) was recorded under A but its lot opened under B and was fully
    // consumed by the OUT under B.
    const after = projectRelabelledDrift(buckets, [
      { fromKey: "2::wh::P::A", toKey: "2::wh::P::B", signedQty: 4 },
    ]);
    expect(after.get("2::wh::P::A")).toEqual({ movQty: 0, lotQty: 0 });
    expect(after.get("2::wh::P::B")).toEqual({ movQty: 0, lotQty: 0 });
  });

  test("a target bucket the caller never loaded materialises at zero rather than being dropped", () => {
    const buckets = new Map([["k::A", { movQty: -1, lotQty: 0 }]]);
    const after = projectRelabelledDrift(buckets, [{ fromKey: "k::A", toKey: "k::B", signedQty: -1 }]);
    expect(after.get("k::B")).toEqual({ movQty: -1, lotQty: 0 });
    expect(after.get("k::A")).toEqual({ movQty: 0, lotQty: 0 });
  });

  test("the input map is never mutated (the dry run prints before AND after)", () => {
    const buckets = new Map([["k::A", { movQty: -1, lotQty: 0 }]]);
    projectRelabelledDrift(buckets, [{ fromKey: "k::A", toKey: "k::B", signedQty: -1 }]);
    expect(buckets.get("k::A")).toEqual({ movQty: -1, lotQty: 0 });
    expect(buckets.has("k::B")).toBe(false);
  });
});
