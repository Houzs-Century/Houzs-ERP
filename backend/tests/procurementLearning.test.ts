import { describe, expect, test } from "vitest";
import {
  learnSupplierBuffers,
  learnSeasonBuffers,
  slipDays,
  percentileOf,
  PROCUREMENT_SUPPLIER_BUFFER_RULE,
  PROCUREMENT_SEASON_BUFFER_RULE,
  DEFAULT_LEARNER_CONFIG,
  type ReceiptSample,
} from "../src/services/agents/procurement-learning";

/* The learner decides how much earlier we ask a supplier to deliver. Getting it
   wrong is expensive in both directions -- too little buffer and the customer's
   order is late ("一旦供应商迟到，我们就完蛋了"); too much and stock lands early and
   sits, which is the turnover the mattress merge rule exists to protect.

   So these lock the judgement calls, not just the arithmetic. */

function po(over: Partial<ReceiptSample> = {}): ReceiptSample {
  return {
    poNumber: "PO-2607-001",
    supplierCode: "SUP-A",
    supplierName: "Supplier A",
    askedDate: "2026-06-10",
    actualDate: "2026-06-10",
    ...over,
  };
}

/** N receipts for one supplier, each slipping the given number of days.
    `from` anchors the asked dates, so a caller can put the evidence in a chosen
    month without breaking the asked/actual pairing. */
function slips(days: number[], over: Partial<ReceiptSample> = {}, from = "2026-06-10"): ReceiptSample[] {
  return days.map((d, i) => {
    const asked = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000);
    const actual = new Date(asked.getTime() + d * 86_400_000);
    return po({
      poNumber: `PO-${i}`,
      askedDate: asked.toISOString().slice(0, 10),
      actualDate: actual.toISOString().slice(0, 10),
      ...over,
    });
  });
}

describe("slipDays — the evidence, and what counts as evidence", () => {
  test("late is positive, early is negative, on-time is zero", () => {
    expect(slipDays("2026-06-10", "2026-06-14")).toBe(4);
    expect(slipDays("2026-06-10", "2026-06-08")).toBe(-2);
    expect(slipDays("2026-06-10", "2026-06-10")).toBe(0);
  });

  test("an unusable date yields null — it must be DROPPED, never scored as 0 slip", () => {
    // Scoring a broken date as "on time" would silently flatter the supplier,
    // which is the exact shape of every bug in this repo's history.
    expect(slipDays("", "2026-06-10")).toBeNull();
    expect(slipDays("2026-06-10", "not-a-date")).toBeNull();
  });

  test("an ISO timestamp is truncated to its date", () => {
    expect(slipDays("2026-06-10T09:00:00Z", "2026-06-12T22:00:00Z")).toBe(2);
  });
});

describe("percentileOf — nearest rank, no interpolation to explain", () => {
  test("p75 of 1..4 covers three values in four", () => {
    expect(percentileOf([1, 2, 3, 4], 75)).toBe(3);
  });
  test("p50 is the median", () => {
    expect(percentileOf([1, 5, 9], 50)).toBe(5);
  });
  test("p100 is the worst case, p0 the best", () => {
    expect(percentileOf([1, 5, 9], 100)).toBe(9);
    expect(percentileOf([1, 5, 9], 0)).toBe(1);
  });
  test("empty evidence is 0, not NaN", () => {
    expect(percentileOf([], 75)).toBe(0);
  });
  test("it does not mutate its input", () => {
    const v = [3, 1, 2];
    percentileOf(v, 50);
    expect(v).toEqual([3, 1, 2]);
  });
});

describe("learnSupplierBuffers", () => {
  test("a chronically late supplier gets a buffer at p75 of its slip", () => {
    const f = learnSupplierBuffers(slips([2, 3, 4, 5, 9]), {});
    expect(f).toHaveLength(1);
    expect(f[0].paramKey).toBe("procurement.supplierBufferDays.SUP-A");
    expect(f[0].samples).toBe(5);
    expect(f[0].percentileSlipDays).toBe(5); // p75 of 5 values -> 4th
    expect(f[0].proposedDays).toBe(5);
    expect(f[0].worstSlipDays).toBe(9);
  });

  test("too few receipts -> NO proposal; the agent must not learn from noise", () => {
    expect(learnSupplierBuffers(slips([5, 5, 5, 5]), {})).toEqual([]);
    expect(learnSupplierBuffers(slips([5, 5, 5, 5, 5]), {})).toHaveLength(1);
  });

  test("a PUNCTUAL supplier gets no buffer — and an EARLY one is never asked to come later", () => {
    // Negative slip must floor at 0. The base lead is the owner's call; a buffer
    // can only ever add safety, never take it away.
    expect(learnSupplierBuffers(slips([-3, -2, -2, -1, 0]), {})).toEqual([]);
  });

  test("a change smaller than minDelta is not proposed — no daily 1-day nudges to approve", () => {
    // p75 = 4, current 3 -> delta 1 < minDelta 2 -> silence.
    expect(learnSupplierBuffers(slips([2, 3, 4, 4, 4]), { "SUP-A": 3 })).toEqual([]);
    // Same evidence, current 0 -> delta 4 -> speak up.
    expect(learnSupplierBuffers(slips([2, 3, 4, 4, 4]), { "SUP-A": 0 })).toHaveLength(1);
  });

  test("a buffer can be proposed DOWNWARD when a supplier improves", () => {
    const f = learnSupplierBuffers(slips([0, 0, 1, 1, 1]), { "SUP-A": 8 });
    expect(f[0].currentDays).toBe(8);
    expect(f[0].proposedDays).toBe(1);
  });

  test("the proposal is capped at the rule's max — the runaway backstop", () => {
    const f = learnSupplierBuffers(slips([90, 95, 100, 110, 120]), {});
    expect(f[0].proposedDays).toBe(PROCUREMENT_SUPPLIER_BUFFER_RULE.max);
    expect(f[0].proposedDays).toBe(30);
  });

  test("every emitted key round-trips the approval whitelist", () => {
    // A key the whitelist would reject is a proposal the agent was never allowed
    // to make -- it must not be emitted at all, rather than 400 at approve time.
    const f = learnSupplierBuffers(
      [...slips([5, 5, 5, 5, 5], { supplierCode: "SUP-A" }), ...slips([6, 6, 6, 6, 6], { supplierCode: "SUP/BAD CODE" })],
      {},
    );
    expect(f.map((x) => x.paramKey)).toEqual(["procurement.supplierBufferDays.SUP-A"]);
    for (const x of f) expect(PROCUREMENT_SUPPLIER_BUFFER_RULE.pattern.test(x.paramKey)).toBe(true);
  });

  test("suppliers are learned independently, worst first", () => {
    const f = learnSupplierBuffers(
      [
        ...slips([2, 2, 2, 2, 2], { supplierCode: "SUP-OK", supplierName: "Punctual" }),
        ...slips([9, 9, 9, 9, 9], { supplierCode: "SUP-BAD", supplierName: "Late" }),
      ],
      {},
    );
    expect(f).toHaveLength(2);
    expect(f[0].paramKey).toContain("SUP-BAD");
    expect(f[0].proposedDays).toBe(9);
    expect(f[1].proposedDays).toBe(2);
  });

  test("a sample with an unusable date is dropped, and drops that supplier below the threshold", () => {
    const good = slips([5, 5, 5, 5]);
    const broken = po({ askedDate: "2026-06-20", actualDate: "" });
    expect(learnSupplierBuffers([...good, broken], {})).toEqual([]);
  });

  test("a blank supplier code is ignored rather than bucketed under empty string", () => {
    expect(learnSupplierBuffers(slips([5, 5, 5, 5, 5], { supplierCode: "  " }), {})).toEqual([]);
  });

  test("the reason carries the evidence a human needs to judge it", () => {
    const f = learnSupplierBuffers(slips([2, 3, 4, 5, 9]), {});
    expect(f[0].reason).toContain("5 completed POs");
    expect(f[0].reason).toContain("Supplier A");
    expect(f[0].reason).toContain("worst 9d late");
    expect(f[0].reason).toContain("0d -> 5d");
  });

  test("a non-numeric current buffer reads as 0 rather than poisoning the delta with NaN", () => {
    const f = learnSupplierBuffers(slips([5, 5, 5, 5, 5]), { "SUP-A": "eight" } as unknown as Record<string, number>);
    expect(f[0].currentDays).toBe(0);
    expect(f[0].proposedDays).toBe(5);
  });

  test("the percentile is a business judgement and is configurable", () => {
    const ev = slips([1, 2, 3, 4, 20]);
    expect(learnSupplierBuffers(ev, {}, { ...DEFAULT_LEARNER_CONFIG, percentile: 50 })[0].proposedDays).toBe(3);
    expect(learnSupplierBuffers(ev, {}, { ...DEFAULT_LEARNER_CONFIG, percentile: 100 })[0].proposedDays).toBe(20);
  });
});

describe("learnSeasonBuffers", () => {
  test("the month keys off the ASKED date — the month the goods were DUE", () => {
    const f = learnSeasonBuffers(slips([4, 4, 4, 4, 4], {}, "2026-12-01"), {});
    expect(f).toHaveLength(1);
    expect(f[0].paramKey).toBe("procurement.seasonBufferDays.12");
    expect(f[0].subject).toBe("December");
  });

  test("months are learned independently, worst first", () => {
    const dec = slips([8, 8, 8, 8, 8], {}, "2026-12-01");
    const jun = slips([3, 3, 3, 3, 3], {}, "2026-06-01");
    const f = learnSeasonBuffers([...dec, ...jun], {});
    expect(f).toHaveLength(2);
    expect(f[0].paramKey).toBe("procurement.seasonBufferDays.12");
    expect(f[0].proposedDays).toBe(8);
    expect(f[1].proposedDays).toBe(3);
  });

  test("a quiet month below minDelta stays silent — a 1-day season is noise, not a season", () => {
    const dec = slips([8, 8, 8, 8, 8], {}, "2026-12-01");
    const jun = slips([1, 1, 1, 1, 1], {}, "2026-06-01");
    const f = learnSeasonBuffers([...dec, ...jun], {});
    expect(f.map((x) => x.paramKey)).toEqual(["procurement.seasonBufferDays.12"]);
  });

  test("a December PO received in January still scores as December — the month goods were DUE", () => {
    // The asked date is what buckets, not the receipt. A late December delivery
    // landing on 2 Jan is December's problem, not January's.
    const f = learnSeasonBuffers(slips([9, 9, 9, 9, 9], {}, "2026-12-27"), {});
    expect(f[0].paramKey).toBe("procurement.seasonBufferDays.12");
  });

  test("too few receipts in a month -> no proposal for that month", () => {
    expect(learnSeasonBuffers(slips([8, 8, 8, 8], {}, "2026-12-01"), {})).toEqual([]);
  });

  test("an unparseable month is ignored, never bucketed", () => {
    const f = learnSeasonBuffers(slips([8, 8, 8, 8, 8]).map((s) => ({ ...s, askedDate: "garbage" })), {});
    expect(f).toEqual([]);
  });

  test("every emitted key round-trips the approval whitelist", () => {
    const f = learnSeasonBuffers(slips([8, 8, 8, 8, 8], {}, "2026-12-01"), {});
    for (const x of f) expect(PROCUREMENT_SEASON_BUFFER_RULE.pattern.test(x.paramKey)).toBe(true);
  });

  test("the whitelist rejects a month that is not 01..12", () => {
    expect(PROCUREMENT_SEASON_BUFFER_RULE.pattern.test("procurement.seasonBufferDays.13")).toBe(false);
    expect(PROCUREMENT_SEASON_BUFFER_RULE.pattern.test("procurement.seasonBufferDays.00")).toBe(false);
    expect(PROCUREMENT_SEASON_BUFFER_RULE.pattern.test("procurement.seasonBufferDays.1")).toBe(false);
  });
});

describe("the rules themselves — the fuse, not the learner's good manners", () => {
  test("a NEGATIVE buffer is outside both rules; it would ship late on purpose", () => {
    expect(PROCUREMENT_SUPPLIER_BUFFER_RULE.min).toBe(0);
    expect(PROCUREMENT_SEASON_BUFFER_RULE.min).toBe(0);
  });

  test("both write into the procurement agent's own setting, at the path lead-time.ts reads", () => {
    const m = PROCUREMENT_SUPPLIER_BUFFER_RULE.pattern.exec("procurement.supplierBufferDays.SUP-A")!;
    expect(PROCUREMENT_SUPPLIER_BUFFER_RULE.path(m)).toEqual(["supplierBufferDays", "SUP-A"]);
    const m2 = PROCUREMENT_SEASON_BUFFER_RULE.pattern.exec("procurement.seasonBufferDays.12")!;
    expect(PROCUREMENT_SEASON_BUFFER_RULE.path(m2)).toEqual(["seasonBufferDays", "12"]);
  });

  test("neither rule matches another agent's namespace", () => {
    expect(PROCUREMENT_SUPPLIER_BUFFER_RULE.pattern.test("delivery.transitDays.PNG")).toBe(false);
    expect(PROCUREMENT_SEASON_BUFFER_RULE.pattern.test("procurement.supplierBufferDays.SUP-A")).toBe(false);
  });
});
