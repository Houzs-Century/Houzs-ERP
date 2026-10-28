import { describe, expect, it } from "vitest";
import { inches, planBedframeVariantFill, spellInches } from "../scripts/lib/supplier-bedframe-variant-plan.mjs";

/* The real shape, from production 2026-09-11: a bedframe purchase line with its
   sales line, nothing received, and a supplier who states all three numbers. */
const pair = (over = {}) => ({
  poItemId: "po-1",
  soItemId: "so-1",
  soDocNo: "HC-SO-011077",
  itemCode: "TRION (A)-(K)",
  supplier: { div: "8", gap: "10", leg: "1" },
  variants: { divanHeight: '8"', legHeight: '1"' },   // gap is the blank one
  receivedQty: 0,
  grnLines: 0,
  doLines: 0,
  soReadyQty: 0,
  soAllocatedBatch: null,
  ...over,
});
const doc = (pairs) => [{ poNumber: "HC-PO-010153", supplierDoc: "SO-2609-040", pairs }];

describe("spelling and reading", () => {
  it("writes the inch mark this repo already uses", () => {
    /* Measured on production 2026-09-11: divan `8"` 419 / `10"` 135, gap `12"`
       244 / `14"` 197, leg `0"` 324 / `4"` 120 — never the bare number. */
    expect(spellInches(10)).toBe('10"');
    expect(spellInches("8")).toBe('8"');
  });

  it("compares as a number, so 10, 10\" and 10 inch are one measurement", () => {
    expect(inches("10\"")).toBe("10");
    expect(inches("10 inch")).toBe("10");
    expect(inches(10)).toBe("10");
    expect(inches(null)).toBeNull();
  });
});

describe("planBedframeVariantFill", () => {
  it("fills only the axis that disagrees, and writes one line once", () => {
    const { writes, holds } = planBedframeVariantFill(doc([pair()]));
    expect(holds).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].set).toEqual({ gap: '10"' });
    expect(writes[0].filled).toEqual(["gap (blank) -> 10\""]);
    expect(writes[0].soItemId).toBe("so-1");
  });

  it("counts a line that already reads the supplier's numbers as agreed", () => {
    const { writes, agreed } = planBedframeVariantFill(doc([
      pair({ variants: { divanHeight: '8"', gap: '10"', legHeight: '1"' } }),
    ]));
    expect(writes).toEqual([]);
    expect(agreed).toBe(1);
  });

  it("CORRECTS a stated number toward the supplier, and says it was a correction", () => {
    /* Owner 2026-09-11: 「supplier 那边写的东西肯定是对的」 — so a different
       number is corrected, not held, but it is reported in its own bucket. */
    const { writes } = planBedframeVariantFill(doc([
      pair({ variants: { divanHeight: '8"', gap: '14"', legHeight: '1"' } }),
    ]));
    expect(writes[0].set).toEqual({ gap: '10"' });
    expect(writes[0].corrected).toEqual(["gap 14\" -> 10\""]);
    expect(writes[0].filled).toEqual([]);
  });

  it("treats the Default placeholder as a blank, not as a pick", () => {
    const { writes } = planBedframeVariantFill(doc([
      pair({ variants: { divanHeight: '8"', gap: "Default", legHeight: '1"' } }),
    ]));
    expect(writes[0].filled).toEqual(["gap (blank) -> 10\""]);
  });

  it("says nothing where the supplier states nothing", () => {
    const { writes, holds, agreed } = planBedframeVariantFill(doc([
      pair({ supplier: {}, variants: {} }),
    ]));
    expect([writes.length, holds.length, agreed]).toEqual([0, 0, 1]);
  });

  it("reads the axis under either of its names", () => {
    /* A line may carry the divan under `divan` rather than `divanHeight` — the
       alias list is the bedframe checker's, kept identical. */
    const { writes, agreed } = planBedframeVariantFill(doc([
      pair({ supplier: { div: "8" }, variants: { divan: '8"' } }),
    ]));
    expect(writes).toEqual([]);
    expect(agreed).toBe(1);
  });

  /* THE 0722 GATE — all three axes compose the bedframe's inventory identity. */
  const moved = [
    ["goods received", { receivedQty: 1 }, /1 already received/],
    ["a goods-received line", { grnLines: 1 }, /1 goods-received line/],
    ["a delivery line", { doLines: 1 }, /1 delivery line/],
    ["allocated stock", { soReadyQty: 2 }, /2 piece\(s\) of stock already allocated/],
    ["an allocated batch", { soAllocatedBatch: "B-1" }, /stock batch B-1 allocated/],
  ];
  for (const [what, over, why] of moved) {
    it(`HOLDS when there is ${what}`, () => {
      const { writes, holds } = planBedframeVariantFill(doc([pair(over)]));
      expect(writes).toEqual([]);
      expect(holds[0].why).toMatch(why);
      expect(holds[0].why).toMatch(/docs\/bugs\/0722/);
    });
  }

  it("writes several axes on one line as a single instruction", () => {
    const { writes } = planBedframeVariantFill(doc([pair({ variants: {} })]));
    expect(writes).toHaveLength(1);
    expect(writes[0].set).toEqual({ divanHeight: '8"', gap: '10"', legHeight: '1"' });
  });
});
