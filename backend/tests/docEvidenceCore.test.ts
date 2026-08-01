import { describe, expect, test } from "vitest";
import {
  resolveDocLineKey,
  planDocKeyAlignment,
  planOverConsumedCorrection,
  planFifoAttribution,
  classifySoLineWarehouse,
  byDateAscNullsLast,
} from "../scripts/lib/doc-evidence-core.mjs";
import { variantKeyMirror } from "../scripts/lib/ledger-repair-core.mjs";
import { computeVariantKey } from "../src/scm/shared/variant-key";

// The 2026-08 document-evidence resolution round (owner: "为什么你不看 SO PO DO
// GR 去解决呢？") writes to the money-critical FIFO ledger, to PO allocations,
// and to SO lines — so, exactly like ledger-repair-core, every decision is a
// pure function pinned here and the production scripts carry no judgement of
// their own.

describe("resolveDocLineKey — the document line's TRUE key, corroborated upstream", () => {
  const sofa = { fabricColor: "FVI BRONZE", seatHeight: "28", legHeight: "6" };

  test("lockstep: the mirror it delegates to computes byte-identical keys to the real computeVariantKey", () => {
    for (const [group, attrs] of [
      ["sofa", sofa],
      ["bedframe", { colorCode: "BF-16", gap: "16", divanHeight: "10", legHeight: "2", totalHeight: "28" }],
      ["mattress", { fabricCode: "IGNORED" }],
      ["accessory", null],
    ] as const) {
      expect(variantKeyMirror(group, attrs as never)).toBe(computeVariantKey(group, attrs as never));
    }
  });

  test("DO line and SO line agreeing on a non-empty key is corroborated", () => {
    const v = resolveDocLineKey({ itemGroup: "sofa", variants: sofa, corroborating: { itemGroup: "sofa", variants: sofa } });
    expect(v.verdict).toBe("corroborated");
    expect(v.key).toBe(computeVariantKey("sofa", sofa));
  });

  test("two NON-empty keys disagreeing is doc-conflict — the paperwork names two different items", () => {
    const v = resolveDocLineKey({
      itemGroup: "sofa",
      variants: sofa,
      corroborating: { itemGroup: "sofa", variants: { fabricColor: "EZ-002", seatHeight: "28", legHeight: "6" } },
    });
    expect(v.verdict).toBe("doc-conflict");
    expect(v.key).not.toBe(v.corroboratingKey);
  });

  test("an empty own key DEFERS to the upstream (origin) document instead of conflicting", () => {
    const v = resolveDocLineKey({ itemGroup: "sofa", variants: null, corroborating: { itemGroup: "sofa", variants: sofa } });
    expect(v.verdict).toBe("corroborated-by-upstream");
    expect(v.key).toBe(computeVariantKey("sofa", sofa));
  });

  test("no upstream line at all is a weaker but usable document (uncorroborated)", () => {
    const v = resolveDocLineKey({ itemGroup: "sofa", variants: sofa });
    expect(v.verdict).toBe("uncorroborated");
    expect(v.key).toBe(computeVariantKey("sofa", sofa));
  });

  test("mattress lines compute '' on both sides and agree by construction", () => {
    const v = resolveDocLineKey({ itemGroup: "mattress", variants: { anything: "x" }, corroborating: { itemGroup: "mattress", variants: null } });
    expect(v.key).toBe("");
    expect(v.verdict).toBe("corroborated");
  });
});

describe("planDocKeyAlignment — ledger rows follow their OWN document's line keys", () => {
  const K1 = "fabriccode=fvi bronze|seatheight=28|legheight=6";
  const K2 = "fabriccode=ez-002|seatheight=28|legheight=6";

  test("a row whose key a clean line documents is consistent", () => {
    const out = planDocKeyAlignment({
      rows: [{ id: "m1", ledgerKey: K1 }],
      lines: [{ ref: "line 1", key: K1, conflict: false }],
    });
    expect(out[0].verdict).toBe("consistent");
  });

  test("THE WOUND: an OUT under a key its DO never documents relabels to the single unclaimed documented key, with the citation", () => {
    const out = planDocKeyAlignment({
      rows: [{ id: "m1", ledgerKey: "fabriccode=wrong-import-key" }],
      lines: [{ ref: "DO line 2", key: K1, conflict: false }],
    });
    expect(out[0].verdict).toBe("relabel");
    expect(out[0].newKey).toBe(K1);
    expect(out[0].citation?.ref).toBe("DO line 2");
  });

  test("sibling matching: a consistent row CLAIMS its line, so the leftover line proves the other row", () => {
    const out = planDocKeyAlignment({
      rows: [
        { id: "m1", ledgerKey: K1 },
        { id: "m2", ledgerKey: "import-damage" },
      ],
      lines: [
        { ref: "line 1", key: K1, conflict: false },
        { ref: "line 2", key: K2, conflict: false },
      ],
    });
    expect(out.find((r) => r.id === "m1")?.verdict).toBe("consistent");
    const m2 = out.find((r) => r.id === "m2");
    expect(m2?.verdict).toBe("relabel");
    expect(m2?.newKey).toBe(K2);
  });

  test("two unclaimed documented keys cannot say which row is which — ambiguous, refused", () => {
    const out = planDocKeyAlignment({
      rows: [{ id: "m1", ledgerKey: "import-damage" }],
      lines: [
        { ref: "line 1", key: K1, conflict: false },
        { ref: "line 2", key: K2, conflict: false },
      ],
    });
    expect(out[0].verdict).toBe("ambiguous-doc-keys");
    expect(out[0].candidates).toEqual(expect.arrayContaining([K1, K2]));
  });

  test("two rows of the same goods both relabel to the one documented key (one line, movements split)", () => {
    const out = planDocKeyAlignment({
      rows: [
        { id: "m1", ledgerKey: "bad-a" },
        { id: "m2", ledgerKey: "bad-a" },
      ],
      lines: [{ ref: "line 1", key: K1, conflict: false }],
    });
    expect(out.every((r) => r.verdict === "relabel" && r.newKey === K1)).toBe(true);
  });

  test("no lines at all for the product: no-document (stocktake candidate, never a guess)", () => {
    const out = planDocKeyAlignment({ rows: [{ id: "m1", ledgerKey: K1 }], lines: [] });
    expect(out[0].verdict).toBe("no-document");
  });

  test("a corroboration-conflicted line proves NOTHING — the row lands doc-conflict, not relabel", () => {
    const out = planDocKeyAlignment({
      rows: [{ id: "m1", ledgerKey: "import-damage" }],
      lines: [{ ref: "line 1", key: K1, conflict: true }],
    });
    expect(out[0].verdict).toBe("doc-conflict");
  });

  test("every documented key already claimed: the row is extra against the paperwork", () => {
    const out = planDocKeyAlignment({
      rows: [
        { id: "m1", ledgerKey: K1 },
        { id: "m2", ledgerKey: "extra" },
      ],
      lines: [{ ref: "line 1", key: K1, conflict: false }],
    });
    expect(out.find((r) => r.id === "m2")?.verdict).toBe("extra-vs-doc");
  });
});

describe("planOverConsumedCorrection — audit 2a's over-consumed arm, corrected from the documents", () => {
  const lot = { lotId: "L-over", qtyReceived: 5, consumed: 7, qtyRemaining: 0 };
  const rows = [
    { id: "c1", movementId: "m1", qty: 5, unitCostSen: 100, consumedAt: "2026-06-01" },
    { id: "c2", movementId: "m2", qty: 2, unitCostSen: 100, consumedAt: "2026-06-05" },
  ];
  const movements = [
    { movementId: "m1", absQty: 5, storedTotalCostSen: 500, consumedCostSen: 500, docNetQty: 5, ledgerShippedQty: 5 },
    { movementId: "m2", absQty: 2, storedTotalCostSen: 200, consumedCostSen: 200, docNetQty: 2, ledgerShippedQty: 2 },
  ];
  const donor = { lotId: "L-donor", qtyRemaining: 2, unitCostSen: 100, receivedAt: "2026-05-20", docKeyMatches: true, finalKeyMatches: true };

  test("THE CORRECTION: excess = consumed - (received - remaining); the NEWEST rows repoint to the FIFO donor, donor decremented", () => {
    const v = planOverConsumedCorrection({ lot, consumptions: rows, movements, donors: [donor] });
    expect(v.verdict).toBe("repoint");
    expect(v.excess).toBe(2);
    expect(v.moves).toEqual([
      expect.objectContaining({ consumptionId: "c2", movementId: "m2", qty: 2, fromLotId: "L-over", toLotId: "L-donor" }),
    ]);
    expect(v.donorTakes).toEqual([{ lotId: "L-donor", qty: 2 }]);
    expect(v.stamps).toEqual([]); // same unit cost — RM0, no stamp
    expect(v.rmDeltaSen).toBe(0);
  });

  test("a donor at a DIFFERENT cost stamps the movement to its new consumption sum and REPORTS the RM delta", () => {
    const v = planOverConsumedCorrection({
      lot,
      consumptions: rows,
      movements,
      donors: [{ ...donor, unitCostSen: 150 }],
    });
    expect(v.verdict).toBe("repoint");
    expect(v.moves[0]).toEqual(expect.objectContaining({ oldUnitCostSen: 100, newUnitCostSen: 150 }));
    expect(v.stamps).toEqual([{ movementId: "m2", newTotalCostSen: 300, deltaSen: 100 }]);
    expect(v.rmDeltaSen).toBe(100);
  });

  test("a row bigger than the excess SPLITS: only the excess moves, the remainder stays (caller derives it from rowQty)", () => {
    const v = planOverConsumedCorrection({
      lot: { lotId: "L-over", qtyReceived: 5, consumed: 8, qtyRemaining: 0 },
      consumptions: [{ id: "c1", movementId: "m1", qty: 8, unitCostSen: 100, consumedAt: "2026-06-01" }],
      movements: [{ movementId: "m1", absQty: 8, storedTotalCostSen: 800, consumedCostSen: 800, docNetQty: 8, ledgerShippedQty: 8 }],
      donors: [{ ...donor, qtyRemaining: 3 }],
    });
    expect(v.verdict).toBe("repoint");
    expect(v.moves).toEqual([expect.objectContaining({ consumptionId: "c1", qty: 3, rowQty: 8 })]);
  });

  test("donors walk FIFO by receipt date and a move can span two donors", () => {
    const v = planOverConsumedCorrection({
      lot: { lotId: "L-over", qtyReceived: 5, consumed: 9, qtyRemaining: 0 },
      consumptions: [{ id: "c1", movementId: "m1", qty: 9, unitCostSen: 100, consumedAt: "2026-06-01" }],
      movements: [{ movementId: "m1", absQty: 9, storedTotalCostSen: 900, consumedCostSen: 900, docNetQty: 9, ledgerShippedQty: 9 }],
      donors: [
        { lotId: "L-newer", qtyRemaining: 3, unitCostSen: 100, receivedAt: "2026-05-25", docKeyMatches: true, finalKeyMatches: true },
        { lotId: "L-older", qtyRemaining: 2, unitCostSen: 100, receivedAt: "2026-05-01", docKeyMatches: true, finalKeyMatches: true },
      ],
    });
    expect(v.verdict).toBe("repoint");
    // oldest receipt first: L-older takes 2, then L-newer takes 2
    expect(v.moves.map((m: { toLotId: string; qty: number }) => [m.toLotId, m.qty])).toEqual([["L-older", 2], ["L-newer", 2]]);
  });

  test("the ledger shipping MORE than the DO documents is doc-overship — the document refutes the ledger; refused with both numbers", () => {
    const v = planOverConsumedCorrection({
      lot,
      consumptions: rows,
      movements: [
        movements[0],
        { ...movements[1], ledgerShippedQty: 3, docNetQty: 2 },
      ],
      donors: [donor],
    });
    expect(v.verdict).toBe("doc-overship");
    expect(v.overships).toEqual([{ movementId: "m2", ledgerShippedQty: 3, docNetQty: 2 }]);
  });

  test("a consuming movement with NO document is refused — an unverifiable shipment cannot be re-attributed", () => {
    const v = planOverConsumedCorrection({
      lot,
      consumptions: rows,
      movements: [movements[0], { ...movements[1], docNetQty: null }],
      donors: [donor],
    });
    expect(v.verdict).toBe("no-document");
  });

  test("no same-goods donor capacity = genuinely no receipt — the stocktake list, never an invention", () => {
    const v = planOverConsumedCorrection({ lot, consumptions: rows, movements, donors: [{ ...donor, qtyRemaining: 1 }] });
    expect(v.verdict).toBe("no-donor");
    expect(v.shortfall).toBe(1);
  });

  test("a donor whose documents do NOT prove the same goods is never eligible", () => {
    const v = planOverConsumedCorrection({ lot, consumptions: rows, movements, donors: [{ ...donor, docKeyMatches: false }] });
    expect(v.verdict).toBe("no-donor");
  });

  test("stored cost disagreeing with the movement's own rows BEFORE the move is cost-conflict — money already contradicts itself", () => {
    const v = planOverConsumedCorrection({
      lot,
      consumptions: rows,
      movements: [movements[0], { ...movements[1], storedTotalCostSen: 999 }],
      donors: [donor],
    });
    expect(v.verdict).toBe("cost-conflict");
  });

  test("idempotence: a lot that already conserves plans nothing", () => {
    const v = planOverConsumedCorrection({
      lot: { lotId: "L", qtyReceived: 5, consumed: 5, qtyRemaining: 0 },
      consumptions: [],
      movements: [],
      donors: [],
    });
    expect(v.verdict).toBe("conserves");
  });
});

describe("planFifoAttribution (R2) — the owner's FIFO rule for consolidated PO lines", () => {
  // The live 2990-PO-2606-023 shape: ONE qty-5 MAKOTO line vs SO-036 x1 +
  // SO-029 x1, remainder stock.
  const makotoPo = [{ id: "p1", itemCode: "MAKOTO-OLIVE", qty: 5, soItemId: null, allocationCount: 0, createdAt: "2026-06-01T00:00:00Z" }];
  const makotoSos = [
    { id: "s36", doc: "2990-SO-2606-036", itemCode: "MAKOTO-OLIVE", qty: 1, deliveryDate: "2026-06-20", lineNo: 1, taken: false },
    { id: "s29", doc: "2990-SO-2606-029", itemCode: "MAKOTO-OLIVE", qty: 1, deliveryDate: "2026-06-10", lineNo: 1, taken: false },
  ];

  test("THE MAKOTO SPLIT: a qty-5 line slices 1 + 1 + 3 stock, demands in delivery-date order", () => {
    const { plans } = planFifoAttribution({ poLines: makotoPo, soLines: makotoSos });
    expect(plans).toHaveLength(1);
    expect(plans[0].slices).toEqual([
      { seq: 1, qty: 1, soItemId: "s29", soDoc: "2990-SO-2606-029" }, // 06-10 first
      { seq: 2, qty: 1, soItemId: "s36", soDoc: "2990-SO-2606-036" },
      { seq: 3, qty: 3, soItemId: null, soDoc: null },
    ]);
    // Sigma(slices) === line qty, always — the trigger's invariant holds by construction.
    expect(plans[0].slices.reduce((a: number, s: { qty: number }) => a + s.qty, 0)).toBe(plans[0].lineQty);
  });

  test("the pillow shape: six lines qty 1,1,1,1,2,1 cover six demands FIFO; the qty-2 line spans two SOs; the surplus books as stock", () => {
    const poLines = [1, 1, 1, 1, 2, 1].map((q, i) => ({
      id: `p${i + 1}`, itemCode: "NTYR-PILLOW", qty: q, soItemId: null, allocationCount: 0, createdAt: `2026-06-01T00:0${i}:00Z`,
    }));
    const soLines = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `s${n}`, doc: `SO-00${n}`, itemCode: "NTYR-PILLOW", qty: 1, deliveryDate: `2026-06-0${n}`, lineNo: 1, taken: false,
    }));
    const { plans, unfilled } = planFifoAttribution({ poLines, soLines });
    expect(plans).toHaveLength(6);
    // Lines 1-4 take SO-001..004; the qty-2 line takes SO-005 AND SO-006; line 6 is pure stock.
    expect(plans[4].slices).toEqual([
      { seq: 1, qty: 1, soItemId: "s5", soDoc: "SO-005" },
      { seq: 2, qty: 1, soItemId: "s6", soDoc: "SO-006" },
    ]);
    expect(plans[5].slices).toEqual([{ seq: 1, qty: 1, soItemId: null, soDoc: null }]);
    expect(unfilled).toEqual([]);
  });

  test("determinism: shuffled input order produces the identical plan (dates, then doc_no, then line, then id)", () => {
    const a = planFifoAttribution({ poLines: makotoPo, soLines: makotoSos });
    const b = planFifoAttribution({ poLines: [...makotoPo].reverse(), soLines: [...makotoSos].reverse() });
    expect(b).toEqual(a);
  });

  test("same-date demands break the tie by doc number ascending — the computeMrp rule verbatim", () => {
    const { plans } = planFifoAttribution({
      poLines: makotoPo,
      soLines: [
        { ...makotoSos[0], deliveryDate: "2026-06-10" }, // SO-036, same date as SO-029
        makotoSos[1],
      ],
    });
    expect(plans[0].slices[0].soDoc).toBe("2990-SO-2606-029"); // -029 < -036
  });

  test("an undated demand sorts LAST, never queue-jumping a dated one", () => {
    const { plans } = planFifoAttribution({
      poLines: makotoPo,
      soLines: [
        { ...makotoSos[0], deliveryDate: null },
        makotoSos[1],
      ],
    });
    expect(plans[0].slices[0].soDoc).toBe("2990-SO-2606-029");
    expect(plans[0].slices[1].soDoc).toBe("2990-SO-2606-036");
  });

  test("idempotence: lines already linked (so_item_id) or already allocated are skipped and reported, never re-planned", () => {
    const { plans, skippedLinked, skippedAllocated } = planFifoAttribution({
      poLines: [
        { ...makotoPo[0], id: "linked", soItemId: "s-existing" },
        { ...makotoPo[0], id: "allocated", allocationCount: 2 },
        { ...makotoPo[0], id: "fresh" },
      ],
      soLines: makotoSos,
    });
    expect(skippedLinked).toEqual(["linked"]);
    expect(skippedAllocated).toEqual(["allocated"]);
    expect(plans.map((p: { poLineId: string }) => p.poLineId)).toEqual(["fresh"]);
  });

  test("taken SO lines are never served; demand no line can cover is reported as unfilled", () => {
    const { plans, unfilled } = planFifoAttribution({
      poLines: [{ ...makotoPo[0], qty: 1 }],
      soLines: [
        { ...makotoSos[1], taken: true }, // s29 already claimed elsewhere
        makotoSos[0],
        { id: "s99", doc: "2990-SO-2606-099", itemCode: "MAKOTO-OLIVE", qty: 2, deliveryDate: "2026-06-30", lineNo: 1, taken: false },
      ],
    });
    expect(plans[0].slices).toEqual([{ seq: 1, qty: 1, soItemId: "s36", soDoc: "2990-SO-2606-036" }]);
    expect(unfilled).toEqual([{ soDoc: "2990-SO-2606-099", soItemId: "s99", itemCode: "MAKOTO-OLIVE", qty: 2 }]);
  });

  test("item codes never cross: a MAKOTO line cannot serve a BRONZE demand", () => {
    const { plans, unfilled } = planFifoAttribution({
      poLines: makotoPo,
      soLines: [{ id: "sb", doc: "SO-X", itemCode: "MAKOTO-BRONZE", qty: 1, deliveryDate: "2026-06-01", lineNo: 1, taken: false }],
    });
    expect(plans[0].slices).toEqual([{ seq: 1, qty: 5, soItemId: null, soDoc: null }]);
    expect(unfilled).toEqual([expect.objectContaining({ itemCode: "MAKOTO-BRONZE" })]);
  });
});

describe("classifySoLineWarehouse (R3) — document evidence order, single-valued or refused", () => {
  test("(a) the line's own DO movement wins outright", () => {
    const v = classifySoLineWarehouse({
      companyId: 1,
      doWarehouseIds: ["wh-kl"],
      siblingWarehouseIds: ["wh-pg"],
      activeWarehouseIds: ["wh-kl", "wh-pg"],
    });
    expect(v).toEqual({ verdict: "stamp", source: "do-movement", warehouseId: "wh-kl", mirror: false });
  });

  test("(a) two DO warehouses is ambiguous — refused, not averaged", () => {
    expect(classifySoLineWarehouse({ companyId: 1, doWarehouseIds: ["wh-kl", "wh-pg"] }).verdict).toBe("do-ambiguous");
  });

  test("(b) sibling agreement: every explicitly-warehoused sibling naming ONE warehouse stamps it", () => {
    const v = classifySoLineWarehouse({ companyId: 1, siblingWarehouseIds: ["wh-kl", "wh-kl"], activeWarehouseIds: ["a", "b"] });
    expect(v).toEqual({ verdict: "stamp", source: "sibling-agreement", warehouseId: "wh-kl", mirror: false });
  });

  test("(b) disagreeing siblings prove a multi-warehouse SO — refused, and (c) must NOT rescue it", () => {
    const v = classifySoLineWarehouse({ companyId: 1, siblingWarehouseIds: ["wh-kl", "wh-pg"], activeWarehouseIds: ["wh-kl"] });
    expect(v.verdict).toBe("siblings-disagree");
  });

  test("(c) the company's single active warehouse is the last resort", () => {
    const v = classifySoLineWarehouse({ companyId: 1, activeWarehouseIds: ["wh-only"] });
    expect(v).toEqual({ verdict: "stamp", source: "single-active-warehouse", warehouseId: "wh-only", mirror: false });
  });

  test("nothing single-valued anywhere: needs-owner", () => {
    expect(classifySoLineWarehouse({ companyId: 1, activeWarehouseIds: ["a", "b"] }).verdict).toBe("needs-owner");
  });

  test("MIRROR GUARD: a stampable company-2990 row verdicts mirror-source — reported with the stamp, never written here", () => {
    const v = classifySoLineWarehouse({ companyId: 2, mirrorCompanyId: 2, doWarehouseIds: ["wh-kl"] });
    expect(v.verdict).toBe("mirror-source");
    expect(v.warehouseId).toBe("wh-kl");
    expect(v.mirror).toBe(true);
  });

  test("a mirror row that is not stampable keeps its refusal verdict, flagged mirror", () => {
    const v = classifySoLineWarehouse({ companyId: 2, mirrorCompanyId: 2, activeWarehouseIds: ["a", "b"] });
    expect(v.verdict).toBe("needs-owner");
    expect(v.mirror).toBe(true);
  });
});

describe("byDateAscNullsLast — the shared computeMrp date order", () => {
  test("dates ascend, null sorts last, equal is stable", () => {
    expect(["2026-02-01", null, "2026-01-01"].sort(byDateAscNullsLast)).toEqual(["2026-01-01", "2026-02-01", null]);
    expect(byDateAscNullsLast("a", "a")).toBe(0);
  });
});
