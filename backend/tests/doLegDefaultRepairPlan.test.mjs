import { describe, expect, it } from "vitest";
import {
  LEG_DEFAULT_FRAGMENT,
  carriesLegDefault,
  planDoLegDefaultRepair,
  stripLegDefault,
} from "../scripts/lib/do-leg-default-repair-plan.mjs";

/* The real shapes, taken from production 2026-09-10 (docs/bugs/0722). */
const WH = "wh-balakong";
const mv = (over = {}) => ({
  id: "mv-1",
  sourceDocNo: "HC-DO-2609-004",
  itemCode: "5535-2A(LHF)",
  qty: 1,
  warehouseId: WH,
  variantKey: "fabriccode=ch141-14|seatheight=30|legheight=default|special=nylon,nylon fabric",
  unitCostSen: 0,
  ...over,
});
const lot = (over = {}) => ({
  id: "lot-1",
  itemCode: "5535-2A(LHF)",
  variantKey: "fabriccode=ch141-14|seatheight=30|special=nylon,nylon fabric",
  warehouseId: WH,
  qtyRemaining: 1,
  unitCostSen: 95611,
  batchNo: "HC-PO-009712",
  ...over,
});

describe("stripLegDefault", () => {
  it("removes the invented segment and leaves the key the lot carries", () => {
    expect(stripLegDefault("fabriccode=modenza-01|seatheight=26|legheight=default")).toBe(
      "fabriccode=modenza-01|seatheight=26",
    );
  });

  it("leaves no stray separator when the segment is first or alone", () => {
    expect(stripLegDefault("legheight=default|fabriccode=bo315-03")).toBe("fabriccode=bo315-03");
    expect(stripLegDefault("legheight=default")).toBe("");
  });

  /* A blind string replace would mangle this one. */
  it("does not touch a genuine leg height that merely starts with the same text", () => {
    expect(stripLegDefault("legheight=default-plus|fabriccode=x")).toBe("legheight=default-plus|fabriccode=x");
  });

  it("is unbothered by a null or empty key", () => {
    expect(stripLegDefault(null)).toBe("");
    expect(carriesLegDefault(null)).toBe(false);
    expect(carriesLegDefault(`a|${LEG_DEFAULT_FRAGMENT}|b`)).toBe(true);
  });
});

describe("planDoLegDefaultRepair", () => {
  it("plans the repair when exactly one costed lot carries the corrected key", () => {
    const { repairs, refusals, totals } = planDoLegDefaultRepair({
      movements: [mv()],
      lots: [lot()],
    });
    expect(refusals).toEqual([]);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({
      movementId: "mv-1",
      itemCode: "5535-2A(LHF)",
      lotId: "lot-1",
      toKey: "fabriccode=ch141-14|seatheight=30|special=nylon,nylon fabric",
      unitCostSen: 95611,
      totalCostSen: 95611,
    });
    expect(totals).toMatchObject({ repairs: 1, piecesToConsume: 1, costToStampSen: 95611 });
  });

  it("multiplies the cost by the quantity the movement actually took", () => {
    const { repairs } = planDoLegDefaultRepair({
      movements: [mv({ qty: 3 })],
      lots: [lot({ qtyRemaining: 5 })],
    });
    expect(repairs[0].totalCostSen).toBe(95611 * 3);
  });

  /* ── every refusal is a test, not a hope ─────────────────────────────────── */

  it("REFUSES a movement that already consumed a lot — the pillow lines on these same documents", () => {
    const { repairs, refusals } = planDoLegDefaultRepair({
      movements: [mv()],
      lots: [lot()],
      consumptionCountByMovementId: { "mv-1": 2 },
    });
    expect(repairs).toEqual([]);
    expect(refusals[0]).toMatchObject({ reason: "ALREADY_CONSUMED" });
  });

  it("REFUSES when no open lot carries the corrected key", () => {
    const { refusals } = planDoLegDefaultRepair({ movements: [mv()], lots: [] });
    expect(refusals[0]).toMatchObject({ reason: "NO_LOT" });
  });

  it("REFUSES when several open lots carry it — that is 0721's duplicate class, not this one", () => {
    const { repairs, refusals } = planDoLegDefaultRepair({
      movements: [mv()],
      lots: [lot({ id: "lot-a" }), lot({ id: "lot-b" })],
    });
    expect(repairs).toEqual([]);
    expect(refusals[0]).toMatchObject({ reason: "AMBIGUOUS" });
    expect(refusals[0].detail).toContain("0721");
  });

  it("REFUSES when the lot holds less than the movement took", () => {
    const { refusals } = planDoLegDefaultRepair({
      movements: [mv({ qty: 2 })],
      lots: [lot({ qtyRemaining: 1 })],
    });
    expect(refusals[0]).toMatchObject({ reason: "SHORT" });
  });

  /* The half-repair guard. Before #3495 costed the cutover stock EVERY line
     would have landed here — which is exactly why this plan could not have been
     run on 2026-09-08. */
  it("REFUSES an uncosted lot rather than fixing stock and leaving COGS at zero", () => {
    const { repairs, refusals } = planDoLegDefaultRepair({
      movements: [mv()],
      lots: [lot({ unitCostSen: 0 })],
    });
    expect(repairs).toEqual([]);
    expect(refusals[0]).toMatchObject({ reason: "LOT_UNCOSTED", lotId: "lot-1" });
  });

  it("REFUSES a movement that never carried the invented key", () => {
    const { refusals } = planDoLegDefaultRepair({
      movements: [mv({ variantKey: "fabriccode=ch141-14|seatheight=30" })],
      lots: [lot()],
    });
    expect(refusals[0]).toMatchObject({ reason: "NOT_IN_SCOPE" });
  });

  it("does not match a lot in a different warehouse", () => {
    const { refusals } = planDoLegDefaultRepair({
      movements: [mv()],
      lots: [lot({ warehouseId: "wh-other" })],
    });
    expect(refusals[0]).toMatchObject({ reason: "NO_LOT" });
  });

  /* The five real lines, planned together. */
  it("plans all five stranded lines and totals what they would stamp", () => {
    const rows = [
      ["mv-1", "HC-DO-2609-004", "5535-2A(LHF)", "fabriccode=ch141-14|seatheight=30|special=nylon,nylon fabric", 95611],
      ["mv-2", "HC-DO-2609-004", "5535-L(RHF)", "fabriccode=ch141-14|seatheight=30|special=nylon,nylon fabric", 71589],
      ["mv-3", "HC-DO-2609-009", "9028-2A(RHF)", "fabriccode=modenza-01|seatheight=26", 112308],
      ["mv-4", "HC-DO-2609-009", "9028-L(LHF)", "fabriccode=modenza-01|seatheight=26", 220000],
      ["mv-5", "HC-DO-2609-011", "8051-STOOL", "fabriccode=bo315-03", 22106],
    ];
    const { repairs, refusals, totals } = planDoLegDefaultRepair({
      movements: rows.map(([id, doc, item, key]) => mv({
        id, sourceDocNo: doc, itemCode: item,
        variantKey: `${key}|${LEG_DEFAULT_FRAGMENT}`,
      })),
      lots: rows.map(([id, , item, key, cost]) => lot({
        id: `lot-${id}`, itemCode: item, variantKey: key, unitCostSen: cost,
      })),
    });
    expect(refusals).toEqual([]);
    expect(repairs).toHaveLength(5);
    expect(totals.piecesToConsume).toBe(5);
    // RM 5,216.14 of COGS that three sales are missing.
    expect(totals.costToStampSen).toBe(521614);
  });
});
