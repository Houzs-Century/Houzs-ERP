import { describe, it, expect } from "vitest";
import {
  computeKpi,
  finalScoreX100,
  resolveTier,
  tierAmountSen,
  weekScoreX100,
  type KpiMetricDef,
  type KpiRating,
  type KpiTierDef,
} from "./hr-kpi";

const METRICS: KpiMetricDef[] = [
  { id: 1, weightBp: 1500 },
  { id: 2, weightBp: 1500 },
  { id: 3, weightBp: 1500 },
  { id: 4, weightBp: 1000 },
  { id: 5, weightBp: 1000 },
  { id: 6, weightBp: 1000 },
  { id: 7, weightBp: 1500 },
  { id: 8, weightBp: 1000 },
];

const TIERS: KpiTierDef[] = [
  { minScoreX100: 450, maxScoreX100: 500, label: "Outstanding", supervisorAmountSen: 80000, staffAmountSen: 10000 },
  { minScoreX100: 400, maxScoreX100: 449, label: "Exceeds Expectations", supervisorAmountSen: 50000, staffAmountSen: 7500 },
  { minScoreX100: 300, maxScoreX100: 399, label: "Meets Expectations", supervisorAmountSen: 25000, staffAmountSen: 5000 },
  { minScoreX100: 200, maxScoreX100: 299, label: "Needs Improvement", supervisorAmountSen: 0, staffAmountSen: 0 },
  { minScoreX100: 0, maxScoreX100: 199, label: "Unsatisfactory", supervisorAmountSen: 0, staffAmountSen: 0 },
];

const week = (w: number, ratings: number[]): KpiRating[] => ratings.map((r, i) => ({ week: w, metricId: METRICS[i].id, ratingX100: r }));

describe("weekScoreX100", () => {
  it("is the weighted average of the week's ratings", () => {
    expect(weekScoreX100(METRICS, week(1, [500, 400, 300, 400, 400, 400, 500, 400]), 1)).toBe(415);
  });

  it("is a plain average when every weight is equal", () => {
    const equal = METRICS.map((m) => ({ ...m, weightBp: 1000 }));
    expect(weekScoreX100(equal, week(1, [500, 400, 300, 400, 400, 400, 500, 400]), 1)).toBe(413);
  });

  it("is null when the week is only part-rated", () => {
    const partial = week(1, [500, 400, 300, 400, 400, 400, 500, 400]).slice(0, 7);
    expect(weekScoreX100(METRICS, partial, 1)).toBeNull();
  });

  it("is null when a rating is out of the 1-5 range", () => {
    const bad = week(1, [500, 400, 300, 400, 400, 400, 500, 600]);
    expect(weekScoreX100(METRICS, bad, 1)).toBeNull();
  });
});

describe("finalScoreX100", () => {
  it("averages only the fully rated weeks", () => {
    const ratings = [
      ...week(1, [500, 500, 500, 500, 500, 500, 500, 500]),
      ...week(2, [300, 300, 300, 300, 300, 300, 300, 300]),
    ];
    expect(finalScoreX100(METRICS, ratings)).toBe(400);
  });

  it("is null when no week is fully rated", () => {
    expect(finalScoreX100(METRICS, [])).toBeNull();
  });
});

describe("resolveTier", () => {
  it("places a score in its inclusive band", () => {
    expect(resolveTier(409, TIERS)?.label).toBe("Exceeds Expectations");
  });

  it("treats the band edges as inclusive (449 vs 450)", () => {
    expect(resolveTier(449, TIERS)?.label).toBe("Exceeds Expectations");
    expect(resolveTier(450, TIERS)?.label).toBe("Outstanding");
  });

  it("is null for a null score", () => {
    expect(resolveTier(null, TIERS)).toBeNull();
  });
});

describe("tierAmountSen", () => {
  it("pays the supervisor more than the storekeeper", () => {
    expect(tierAmountSen(TIERS[1], "SUPERVISOR")).toBe(50000);
    expect(tierAmountSen(TIERS[1], "STAFF")).toBe(7500);
  });
});

describe("computeKpi", () => {
  it("scores a month end to end and books the supervisor amount", () => {
    const ratings = [
      ...week(1, [500, 400, 300, 400, 400, 400, 500, 400]),
      ...week(2, [400, 400, 300, 400, 400, 400, 400, 300]),
      ...week(3, [400, 500, 300, 400, 400, 400, 400, 500]),
      ...week(4, [500, 400, 400, 400, 400, 400, 500, 400]),
    ];
    const r = computeKpi(METRICS, ratings, TIERS, "SUPERVISOR");
    expect(r.weekScores[0]).toBe(415);
    expect(r.finalX100).not.toBeNull();
    expect(r.finalX100! >= 400 && r.finalX100! <= 449).toBe(true);
    expect(r.tierLabel).toBe("Exceeds Expectations");
    expect(r.amountSen).toBe(50000);
  });

  it("pays nothing in the lower tiers and leaves the final null when unrated", () => {
    const low = week(1, [200, 200, 200, 200, 200, 200, 200, 200]);
    const r = computeKpi(METRICS, low, TIERS, "SUPERVISOR");
    expect(r.finalX100).toBe(200);
    expect(r.tierLabel).toBe("Needs Improvement");
    expect(r.amountSen).toBe(0);

    const blank = computeKpi(METRICS, [], TIERS, "SUPERVISOR");
    expect(blank.finalX100).toBeNull();
    expect(blank.tierLabel).toBeNull();
    expect(blank.amountSen).toBe(0);
  });
});
