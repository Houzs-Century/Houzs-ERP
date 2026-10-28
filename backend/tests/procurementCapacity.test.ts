import { describe, expect, test } from "vitest";
import {
  estimateCapacity,
  detectOverload,
  detectSlack,
  weekStartOf,
  DEFAULT_CAPACITY_CONFIG,
  type ReceiptUnit,
  type LoadUnit,
} from "../src/services/agents/procurement-capacity";

/* These lock the OWNER'S MODEL, not the arithmetic:

     "供应商的产量一定都是稳定的。除非是他们一 overload ... 他们一提早送货，就代表
      他们的产量其实很松散。"

   Output is stable; lateness is a symptom of LOAD. And the second sentence is
   the measurement trick: we only ever observe min(capacity, load), so a slack
   supplier's receipts understate what they can do. A LATE week is the only week
   that witnesses the ceiling. Get that backwards and the model reads a punctual
   supplier as a weak one. */

const MON = "2026-06-01"; // a Monday

function weeksOf(qtyPerWeek: number[], slipDays: number, over: Partial<ReceiptUnit> = {}): ReceiptUnit[] {
  return qtyPerWeek.map((qty, i) => ({
    supplierCode: "SUP-A",
    category: "mattress",
    receivedDate: new Date(Date.parse(`${MON}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    qty,
    slipDays,
    ...over,
  }));
}

function load(qty: number, dueDate: string, over: Partial<LoadUnit> = {}): LoadUnit {
  return { supplierCode: "SUP-A", category: "mattress", dueDate, qty, ...over };
}

describe("weekStartOf — a capacity week is the same seven days as a merge window", () => {
  test("every day of a Mon-Sun week buckets to that Monday", () => {
    for (const d of ["2026-06-01", "2026-06-04", "2026-06-07"]) expect(weekStartOf(d)).toBe("2026-06-01");
    expect(weekStartOf("2026-06-08")).toBe("2026-06-08");
  });
  test("an unusable date is null, never bucketed somewhere arbitrary", () => {
    expect(weekStartOf(null)).toBeNull();
    expect(weekStartOf("garbage")).toBeNull();
  });
});

describe("estimateCapacity — the ceiling is witnessed by the LATE weeks", () => {
  test("a supplier running LATE reveals its ceiling: those weeks are the evidence", () => {
    const [c] = estimateCapacity(weeksOf([240, 250, 245, 255, 250, 250], 4));
    expect(c.unitsPerWeek).toBe(250);
    expect(c.weeksAtCeiling).toBe(6);
    expect(c.isLowerBound).toBe(false);
  });

  test("THE INSIGHT: slack weeks are a FLOOR, not the ceiling — never observed late", () => {
    // 6 weeks, all delivered EARLY. Receipts measure what we gave them (100),
    // which says nothing about what they could have done.
    const [c] = estimateCapacity(weeksOf([100, 100, 100, 100, 100, 100], -3));
    expect(c.isLowerBound).toBe(true);
    expect(c.unitsPerWeek).toBe(100);
  });

  test("THE INSIGHT: a mixed history estimates from the LATE weeks, ignoring the slack ones", () => {
    // Slack weeks at 100, flat-out weeks at 250. The naive average (~175) is
    // wrong in both directions; the ceiling is what the busy weeks showed.
    const slack = weeksOf([100, 100, 100], -2);
    const busy = weeksOf([250, 240, 250], 5).map((r, i) => ({
      ...r,
      receivedDate: new Date(Date.parse(`${MON}T00:00:00Z`) + (i + 3) * 7 * 86_400_000).toISOString().slice(0, 10),
    }));
    const [c] = estimateCapacity([...slack, ...busy]);
    expect(c.unitsPerWeek).toBe(250);
    expect(c.weeksAtCeiling).toBe(3);
    expect(c.isLowerBound).toBe(false);
  });

  test("a quiet quarter must not read as low capacity — zero weeks are excluded, not averaged in", () => {
    // Only 6 weeks with receipts; the gaps between them are our silence, not
    // the supplier's inability.
    const sparse: ReceiptUnit[] = [0, 5, 10, 15, 20, 25].map((wk) => ({
      supplierCode: "SUP-A",
      category: "mattress",
      receivedDate: new Date(Date.parse(`${MON}T00:00:00Z`) + wk * 7 * 86_400_000).toISOString().slice(0, 10),
      qty: 200,
      slipDays: 3,
    }));
    const [c] = estimateCapacity(sparse);
    expect(c.unitsPerWeek).toBe(200);
    expect(c.weeksObserved).toBe(6);
  });

  test("too few weeks -> no estimate at all; an agent must not guess a ceiling", () => {
    expect(estimateCapacity(weeksOf([200, 200, 200, 200, 200], 3))).toEqual([]);
    expect(estimateCapacity(weeksOf([200, 200, 200, 200, 200, 200], 3))).toHaveLength(1);
  });

  test("capacity is per (supplier, category) — a sofa and a mattress are not one pool", () => {
    const mattress = weeksOf([200, 200, 200, 200, 200, 200], 3);
    const sofa = weeksOf([20, 20, 20, 20, 20, 20], 3, { category: "sofa" });
    const out = estimateCapacity([...mattress, ...sofa]);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.category === "mattress")!.unitsPerWeek).toBe(200);
    expect(out.find((c) => c.category === "sofa")!.unitsPerWeek).toBe(20);
  });

  test("a supplier code containing a space does not bleed into another's capacity", () => {
    // The composite key is NUL-joined precisely so this cannot happen: split on
    // a space and "SUP A"/"mattress" would mis-attribute.
    const a = weeksOf([200, 200, 200, 200, 200, 200], 3, { supplierCode: "SUP A" });
    const b = weeksOf([50, 50, 50, 50, 50, 50], 3, { supplierCode: "SUP", category: "a mattress" });
    const out = estimateCapacity([...a, ...b]);
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.supplierCode === "SUP A")!.unitsPerWeek).toBe(200);
  });

  test("the percentile is not the max — one catch-up week is not a sustainable rate", () => {
    // p90 would have picked 900 here: nearest-rank p90 IS the max for n <= 9,
    // and minWeeks is 6. That is why the default is p75.
    const [c] = estimateCapacity(weeksOf([200, 200, 200, 200, 200, 900], 3));
    expect(c.unitsPerWeek).toBe(200);
    expect(estimateCapacity(weeksOf([200, 200, 200, 200, 200, 900], 3), {
      ...DEFAULT_CAPACITY_CONFIG, percentile: 90,
    })[0].unitsPerWeek).toBe(900);
  });

  test("junk rows are dropped rather than scored", () => {
    const good = weeksOf([200, 200, 200, 200, 200, 200], 3);
    const junk: ReceiptUnit[] = [
      { supplierCode: "", category: "mattress", receivedDate: MON, qty: 999, slipDays: 3 },
      { supplierCode: "SUP-A", category: "", receivedDate: MON, qty: 999, slipDays: 3 },
      { supplierCode: "SUP-A", category: "mattress", receivedDate: "garbage", qty: 999, slipDays: 3 },
      { supplierCode: "SUP-A", category: "mattress", receivedDate: MON, qty: -5, slipDays: 3 },
    ];
    const [c] = estimateCapacity([...good, ...junk]);
    expect(c.unitsPerWeek).toBe(200);
  });
});

describe("detectOverload — lateness predicted from load, not from a supplier's reputation", () => {
  const capacity = estimateCapacity(weeksOf([250, 250, 250, 250, 250, 250], 4));

  test("400 due against 250/week is 150 over and about a week late", () => {
    const [f] = detectOverload(capacity, [load(400, "2026-12-09")]);
    expect(f.loadUnits).toBe(400);
    expect(f.capacityUnitsPerWeek).toBe(250);
    expect(f.overloadUnits).toBe(150);
    expect(f.expectedSlipWeeks).toBe(1);
    expect(f.weekStart).toBe("2026-12-07");
  });

  test("the reason hands the owner the three real options, not a verdict", () => {
    const [f] = detectOverload(capacity, [load(400, "2026-12-09")]);
    expect(f.reason).toContain("400 units due");
    expect(f.reason).toContain("250/week");
    expect(f.reason).toContain("split it to another supplier");
  });

  test("load within capacity is not a finding", () => {
    expect(detectOverload(capacity, [load(200, "2026-12-09")])).toEqual([]);
    expect(detectOverload(capacity, [load(250, "2026-12-09")])).toEqual([]);
  });

  test("load is summed per week — two POs due the same week compete for one ceiling", () => {
    const [f] = detectOverload(capacity, [load(200, "2026-12-07"), load(200, "2026-12-11")]);
    expect(f.loadUnits).toBe(400);
  });

  test("the same units spread across two weeks are NOT an overload", () => {
    expect(detectOverload(capacity, [load(200, "2026-12-07"), load(200, "2026-12-14")])).toEqual([]);
  });

  test("NO estimate -> NO claim. The agent must not call a supplier overloaded it has never measured", () => {
    expect(detectOverload([], [load(9999, "2026-12-09")])).toEqual([]);
    expect(detectOverload(capacity, [load(9999, "2026-12-09", { supplierCode: "SUP-UNKNOWN" })])).toEqual([]);
  });

  test("an estimate from a never-late supplier is flagged weak — it is only a floor", () => {
    const floorOnly = estimateCapacity(weeksOf([100, 100, 100, 100, 100, 100], -3));
    const [f] = detectOverload(floorOnly, [load(300, "2026-12-09")]);
    expect(f.capacityIsLowerBound).toBe(true);
    expect(f.reason).toContain("FLOOR");
  });

  test("a big overload slips proportionally more weeks", () => {
    const [f] = detectOverload(capacity, [load(1000, "2026-12-09")]);
    expect(f.overloadUnits).toBe(750);
    expect(f.expectedSlipWeeks).toBe(3);
  });

  test("worst overload first", () => {
    const cap = [
      ...estimateCapacity(weeksOf([250, 250, 250, 250, 250, 250], 4)),
      ...estimateCapacity(weeksOf([100, 100, 100, 100, 100, 100], 4, { supplierCode: "SUP-B" })),
    ];
    const f = detectOverload(cap, [load(300, "2026-12-09"), load(500, "2026-12-09", { supplierCode: "SUP-B" })]);
    expect(f[0].supplierCode).toBe("SUP-B");
    expect(f[0].overloadUnits).toBe(400);
  });
});

describe("detectSlack — the other half of the sentence: who has room", () => {
  const capacity = [
    ...estimateCapacity(weeksOf([250, 250, 250, 250, 250, 250], 4)),
    ...estimateCapacity(weeksOf([300, 300, 300, 300, 300, 300], 4, { supplierCode: "SUP-B" })),
  ];

  test("a supplier under its ceiling has spare capacity to absorb an overload", () => {
    const s = detectSlack(capacity, [load(250, "2026-12-09"), load(50, "2026-12-09", { supplierCode: "SUP-B" })], "2026-12-07");
    expect(s).toHaveLength(1);
    expect(s[0].supplierCode).toBe("SUP-B");
    expect(s[0].spareUnits).toBe(250);
  });

  test("a supplier with NO load that week is the most slack there is, not an omission", () => {
    const s = detectSlack(capacity, [load(250, "2026-12-09")], "2026-12-07");
    expect(s.map((x) => x.supplierCode)).toEqual(["SUP-B"]);
    expect(s[0].loadUnits).toBe(0);
    expect(s[0].spareUnits).toBe(300);
  });

  test("a fully-loaded supplier is not offered as somewhere to put more work", () => {
    expect(
      detectSlack(capacity, [load(250, "2026-12-09"), load(300, "2026-12-09", { supplierCode: "SUP-B" })], "2026-12-07"),
    ).toEqual([]);
  });

  test("only the asked week counts — next week's load does not consume this week's room", () => {
    const s = detectSlack(capacity, [load(250, "2026-12-14")], "2026-12-07");
    expect(s.find((x) => x.supplierCode === "SUP-A")!.spareUnits).toBe(250);
  });

  test("most room first — that is the order the owner would pick from", () => {
    const s = detectSlack(capacity, [], "2026-12-07");
    expect(s[0].supplierCode).toBe("SUP-B");
    expect(s[0].spareUnits).toBe(300);
  });
});

describe("the config is a set of judgement calls, all reachable", () => {
  test("defaults are stated, not hidden", () => {
    expect(DEFAULT_CAPACITY_CONFIG).toEqual({
      minWeeks: 6,
      percentile: 75,
      ceilingSlipDays: 1,
      minOverloadUnits: 1,
    });
  });

  test("ceilingSlipDays decides which weeks witness the ceiling", () => {
    // At the default (1d), a 0-day-slip week is not flat out -> lower bound.
    const onTime = estimateCapacity(weeksOf([200, 200, 200, 200, 200, 200], 0));
    expect(onTime[0].isLowerBound).toBe(true);
    // Told that on-time IS flat out, the same weeks become witnesses.
    const strict = estimateCapacity(weeksOf([200, 200, 200, 200, 200, 200], 0), {
      ...DEFAULT_CAPACITY_CONFIG,
      ceilingSlipDays: 0,
    });
    expect(strict[0].isLowerBound).toBe(false);
  });
});
