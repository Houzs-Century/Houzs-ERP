/* HR KPI appraisal scoring (HC-0125). The monthly KPI allowance for a
 * storekeeper supervisor and (same template) the storekeepers under them: a
 * reviewer rates each weighted KPI 1-5 for up to four weeks; a fully rated
 * week scores the weighted average of its ratings, the month's final score is
 * the mean of the fully rated weeks, and that final score falls in a payout
 * tier which pays a fixed RM amount (one figure for a supervisor, a smaller
 * one for a storekeeper). The amount becomes that month's KPI allowance. Pure,
 * no I/O.
 *
 * Weights need not sum to 1: the week score divides the weighted sum by the
 * summed weight, so it always stays on the 1-5 rating scale and equal weights
 * give a plain average.
 *
 * ONE home: backend/src/scm/shared/hr-kpi.ts is the original and
 * frontend/src/vendor/shared/hr-kpi.ts its byte-identical copy
 * (check-shared-mirrors.mjs), so the KPI page scores exactly as the server
 * that books the allowance does. */

export const KPI_WEEKS = 4;
export const KPI_RATING_MIN_X100 = 100; // 1.00
export const KPI_RATING_MAX_X100 = 500; // 5.00

export type KpiRole = "SUPERVISOR" | "STAFF";

/** A scored KPI line: its id and its weight in basis points (1500 = 0.15). */
export type KpiMetricDef = { id: number; weightBp: number };
/** One cell of the grid: a 1-5 rating (x100) for a metric in a given week. */
export type KpiRating = { week: number; metricId: number; ratingX100: number };
/** A payout band: an inclusive final-score range (x100) and the RM (sen) it
 *  pays, by role. */
export type KpiTierDef = { minScoreX100: number; maxScoreX100: number; label: string; supervisorAmountSen: number; staffAmountSen: number };

export function tierAmountSen(tier: KpiTierDef, role: KpiRole): number {
  return role === "SUPERVISOR" ? tier.supervisorAmountSen : tier.staffAmountSen;
}

function ratingOf(ratings: KpiRating[], week: number, metricId: number): number | null {
  const r = ratings.find((x) => x.week === week && x.metricId === metricId);
  if (!r || !Number.isFinite(r.ratingX100)) return null;
  if (r.ratingX100 < KPI_RATING_MIN_X100 || r.ratingX100 > KPI_RATING_MAX_X100) return null;
  return r.ratingX100;
}

/** A week's weighted-average score (x100, 100-500), or null when any metric is
 *  unrated that week (a part-rated week does not count). */
export function weekScoreX100(metrics: KpiMetricDef[], ratings: KpiRating[], week: number): number | null {
  let weighted = 0;
  let weight = 0;
  for (const m of metrics) {
    const rating = ratingOf(ratings, week, m.id);
    if (rating === null) return null;
    weighted += m.weightBp * rating;
    weight += m.weightBp;
  }
  if (weight <= 0) return null;
  return Math.round(weighted / weight);
}

/** The weeks (1..KPI_WEEKS) that are fully rated. */
export function completeWeeks(metrics: KpiMetricDef[], ratings: KpiRating[]): number[] {
  const weeks: number[] = [];
  for (let w = 1; w <= KPI_WEEKS; w++) {
    if (weekScoreX100(metrics, ratings, w) !== null) weeks.push(w);
  }
  return weeks;
}

/** The month's final score (x100): the mean of the fully rated weeks, or null
 *  when no week is fully rated. */
export function finalScoreX100(metrics: KpiMetricDef[], ratings: KpiRating[]): number | null {
  if (metrics.length === 0) return null;
  const scores: number[] = [];
  for (let w = 1; w <= KPI_WEEKS; w++) {
    const s = weekScoreX100(metrics, ratings, w);
    if (s !== null) scores.push(s);
  }
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((sum, v) => sum + v, 0) / scores.length);
}

/** The first tier whose inclusive range holds the final score, or null. */
export function resolveTier(finalX100: number | null, tiers: KpiTierDef[]): KpiTierDef | null {
  if (finalX100 === null) return null;
  return tiers.find((t) => finalX100 >= t.minScoreX100 && finalX100 <= t.maxScoreX100) ?? null;
}

export type KpiComputed = {
  /** One score per week, index 0 = week 1; null where the week is not fully rated. */
  weekScores: (number | null)[];
  finalX100: number | null;
  tierLabel: string | null;
  amountSen: number;
};

/** Everything the page shows live and the server books: the per-week scores,
 *  the monthly final, its tier and the RM (sen) that tier pays this role. */
export function computeKpi(metrics: KpiMetricDef[], ratings: KpiRating[], tiers: KpiTierDef[], role: KpiRole): KpiComputed {
  const weekScores: (number | null)[] = [];
  for (let w = 1; w <= KPI_WEEKS; w++) weekScores.push(weekScoreX100(metrics, ratings, w));
  const finalX100 = finalScoreX100(metrics, ratings);
  const tier = resolveTier(finalX100, tiers);
  return { weekScores, finalX100, tierLabel: tier ? tier.label : null, amountSen: tier ? tierAmountSen(tier, role) : 0 };
}
