import { describe, expect, test } from "vitest";
import {
  classifyGrnInboundGap,
  pickCostBasis,
  classifyMovementRelabel,
  projectRelabelledDrift,
  toMyrSenMirror,
  variantKeyMirror,
  deriveGrnLineBasis,
  planFamilyReconstruction,
} from "../scripts/lib/ledger-repair-core.mjs";
import { toMyrSen } from "../src/scm/lib/fx";
import { computeVariantKey, type VariantAttrs } from "../src/scm/shared/variant-key";

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

describe("LOCKSTEP mirrors — the script-side copies must equal the app's real functions", () => {
  test("toMyrSenMirror === toMyrSen (lib/fx.ts) across the shapes the GRN paths produce", () => {
    const cases: Array<[number, unknown]> = [
      [12345, 1], [12345, "1"], [55000, 4.45], [55000, "4.450000"],
      [0, 3], [999, null], [999, undefined], [999, 0], [999, -2], [999, NaN],
      [1, 0.5], [7, 3.333333],
    ];
    for (const [sen, rate] of cases) {
      expect(toMyrSenMirror(sen, rate), `sen=${sen} rate=${String(rate)}`).toBe(toMyrSen(sen, rate));
    }
  });

  test("variantKeyMirror === computeVariantKey (shared/variant-key.ts) across a fixture matrix", () => {
    const attrsMatrix: Array<VariantAttrs | null | undefined> = [
      null,
      undefined,
      {},
      { fabricCode: "FVI-BRONZE" },
      { colorCode: "GOLD " },
      { colourCode: "Teal" },
      { fabricColor: "NAVY" },
      { fabricCode: "A", colorCode: "B" }, // canonical wins
      { seatHeight: "18" },
      { depth: "17" },
      { seatHeight: "18", depth: "17" },
      { legHeight: "5" },
      { sofaLegHeight: "6" },
      { gap: "2", divanHeight: "10", legHeight: "4", totalHeight: "16" },
      { specials: ["b", "A", ""] },
      { specials: [{ code: "X1" }, { label: "y2" }, {}] },
      { fabricCode: "F", specials: ["s2", "s1"] },
    ];
    const groups = ["sofa", "SOFA", " Sofa ", "bedframe", "mattress", "accessory", "others", "service", "", null, undefined, "unknown-group"];
    for (const g of groups) {
      for (const a of attrsMatrix) {
        expect(variantKeyMirror(g as string, a), `group=${String(g)} attrs=${JSON.stringify(a)}`)
          .toBe(computeVariantKey(g as string, a));
      }
    }
  });
});

describe("deriveGrnLineBasis (W2 fallback) — the line's own landed cost, single-valued facts or refusal", () => {
  const line = { unit_price_centi: 55000, item_group: "mattress", variants: null };

  test("THE LIVE WOUND: no sibling movement — the line's own price x rate becomes the basis", () => {
    const v = deriveGrnLineBasis({
      lines: [line],
      qty: 1,
      headerWarehouseId: "wh-hdr",
      exchangeRate: 1,
      grnMovementWarehouses: ["wh-mov", "wh-mov"],
      grnMovementBatches: ["2990-PO-2606-001", "2990-PO-2606-001"],
      companyId: 2,
    });
    expect(v.verdict).toBe("line-insert");
    expect(v.insert).toEqual({
      qty: 1, warehouseId: "wh-mov", variantKey: "", batchNo: "2990-PO-2606-001",
      companyId: 2, unitCostSen: 55000,
    });
  });

  test("a foreign-currency line converts at the GRN's rate (the toMyrSen path)", () => {
    const v = deriveGrnLineBasis({
      lines: [{ ...line, unit_price_centi: 10000 }],
      qty: 2, headerWarehouseId: "wh", exchangeRate: 4.45,
      grnMovementWarehouses: [], grnMovementBatches: [], companyId: 2,
    });
    expect(v.verdict).toBe("line-insert");
    expect(v.insert.unitCostSen).toBe(44500);
    expect(v.insert.warehouseId).toBe("wh"); // header fallback when no movements
    expect(v.insert.batchNo).toBeNull(); // no single batch -> unbatched
  });

  test("several lines for the product cannot attribute the delta — refused", () => {
    expect(deriveGrnLineBasis({ lines: [line, line], qty: 1, headerWarehouseId: "wh", exchangeRate: 1, companyId: 2 }).verdict).toBe("multi-line");
  });

  test("movements across TWO warehouses fall back to the header; no header at all refuses", () => {
    const two = { lines: [line], qty: 1, exchangeRate: 1, grnMovementWarehouses: ["w1", "w2"], grnMovementBatches: [], companyId: 2 };
    expect(deriveGrnLineBasis({ ...two, headerWarehouseId: "wh-hdr" }).insert.warehouseId).toBe("wh-hdr");
    expect(deriveGrnLineBasis({ ...two, headerWarehouseId: null }).verdict).toBe("no-warehouse");
  });

  test("a zero price is not a basis — refused, same rule as pickCostBasis", () => {
    expect(deriveGrnLineBasis({ lines: [{ ...line, unit_price_centi: 0 }], qty: 1, headerWarehouseId: "wh", exchangeRate: 1, companyId: 2 }).verdict).toBe("zero-cost");
  });

  test("the variant key comes from the line's own variants via the lockstep mirror", () => {
    const v = deriveGrnLineBasis({
      lines: [{ unit_price_centi: 100, item_group: "sofa", variants: { fabricCode: "FVI", legHeight: "5" } }],
      qty: 1, headerWarehouseId: "wh", exchangeRate: 1,
      grnMovementWarehouses: [], grnMovementBatches: [], companyId: 2,
    });
    expect(v.insert.variantKey).toBe(computeVariantKey("sofa", { fabricCode: "FVI", legHeight: "5" }));
  });
});

describe("planFamilyReconstruction (W4 phase 1) — rebuild dropped consumption rows only when the family proves them", () => {
  const mov = (id: string, qty: number, consumed: number, cost: number, at: string, consumedCost = 0) => ({
    movementId: id, qty, alreadyConsumed: consumed, alreadyConsumedCostSen: consumedCost, totalCostSen: cost, createdAt: at,
  });
  const lot = (id: string, recv: number, cons: number, rem: number, cost: number, at: string) => ({
    lotId: id, qtyReceived: recv, consumed: cons, qtyRemaining: rem, unitCostSen: cost, receivedAt: at,
  });

  test("THE XAMMAR SHAPE: costed OUT with zero consumptions + decremented lot with zero rows — pure re-link at RM0", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 2, 0, 166000, "2026-07-01")],
      lots: [lot("l1", 5, 0, 3, 83000, "2026-06-01")],
    });
    expect(v.verdict).toBe("reconstruct");
    expect(v.pairs).toEqual([{ movementId: "m1", lotId: "l1", qty: 2, unitCostSen: 83000 }]);
    expect(v.stamps).toEqual([]);
    expect(v.rmStampedSen).toBe(0);
  });

  test("a zero-cost movement gets stamped from the reconstructed rows (0154-style) and the RM is reported", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 1, 0, 0, "2026-07-01")],
      lots: [lot("l1", 4, 2, 1, 55000, "2026-06-01")],
    });
    expect(v.verdict).toBe("reconstruct");
    expect(v.stamps).toEqual([{ movementId: "m1", newTotalCostSen: 55000 }]);
    expect(v.rmStampedSen).toBe(55000);
  });

  test("sums that do not match refuse the whole family — the two sides describe different histories", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 3, 0, 0, "2026-07-01")],
      lots: [lot("l1", 5, 0, 3, 100, "2026-06-01")],
    });
    expect(v.verdict).toBe("sums-mismatch");
    expect(v.totalShort).toBe(3);
    expect(v.totalDeficit).toBe(2);
  });

  test("a stored cost that disagrees with existing + paired refuses — never contradict money already booked", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 2, 0, 999, "2026-07-01")],
      lots: [lot("l1", 5, 1, 2, 83000, "2026-06-01")],
    });
    expect(v.verdict).toBe("cost-conflict");
    expect(v.conflicts).toEqual([{ movementId: "m1", storedCostSen: 999, existingConsumedCostSen: 0, pairedCostSen: 166000 }]);
  });

  test("FIFO pairing: oldest movement takes oldest deficit, spanning lots when needed", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m2", 2, 0, 0, "2026-07-02"), mov("m1", 3, 0, 0, "2026-07-01")],
      lots: [lot("l2", 2, 0, 0, 200, "2026-06-02"), lot("l1", 3, 0, 0, 100, "2026-06-01")],
    });
    expect(v.verdict).toBe("reconstruct");
    expect(v.pairs).toEqual([
      { movementId: "m1", lotId: "l1", qty: 3, unitCostSen: 100 },
      { movementId: "m2", lotId: "l2", qty: 2, unitCostSen: 200 },
    ]);
  });

  test("partially-linked movement: residual pairs, and the FULL-cost import shape is a pure re-link", () => {
    // 5 shipped, 3 already linked at 100/u (existing rows cost 300), stored
    // total 500 = 300 + the missing 2x100 — the import stamped the full cost
    // and dropped only the rows.
    const v = planFamilyReconstruction({
      movements: [mov("m1", 5, 3, 500, "2026-07-01", 300)],
      lots: [lot("l1", 5, 3, 0, 100, "2026-06-01")],
    });
    expect(v.verdict).toBe("reconstruct");
    expect(v.pairs).toEqual([{ movementId: "m1", lotId: "l1", qty: 2, unitCostSen: 100 }]);
    expect(v.stamps).toEqual([]);
    expect(v.rmStampedSen).toBe(0);
  });

  test("partially-linked movement whose cost covers only the linked part gets topped up (RM = the paired part)", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 5, 3, 300, "2026-07-01", 300)],
      lots: [lot("l1", 5, 3, 0, 100, "2026-06-01")],
    });
    expect(v.verdict).toBe("reconstruct");
    expect(v.stamps).toEqual([{ movementId: "m1", newTotalCostSen: 500 }]);
    expect(v.rmStampedSen).toBe(200);
  });

  test("a fully-conserving family is balanced — nothing to do (idempotence)", () => {
    const v = planFamilyReconstruction({
      movements: [mov("m1", 2, 2, 100, "2026-07-01")],
      lots: [lot("l1", 2, 2, 0, 50, "2026-06-01")],
    });
    expect(v.verdict).toBe("balanced");
  });
});
