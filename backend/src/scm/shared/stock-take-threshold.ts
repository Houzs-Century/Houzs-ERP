// ----------------------------------------------------------------------------
// stock-take-threshold — the PURE decision for "does this count need a
// supervisor to post?". Owner-approved phase 1 (2026-08-08): variances beyond a
// threshold require the scm.stock_take.supervise permission, with the refusal
// saying so. Sibling of adjustment-cost.ts: the rule that could be wrong about
// stock lives here with a test beside it, not inline in the route.
//
// Two independent limits, breach on EITHER:
//   • qty   — |adjustment| strictly greater than qtyLimit lines need review
//             (default 5 units: a cycle count that finds ±5 of something is
//             routine; ±6 sofas is a story someone senior should hear first).
//   • value — |adjustment| × unit cost (integer SEN) strictly greater than
//             valueLimitSen (default RM500). A qty-2 variance on a RM3,000
//             mattress is NOT routine, which is why qty alone is not enough.
//             Lines whose cost basis is unknown (a negative variance on a SKU
//             with no priced lots) are judged on qty alone — an unknown value
//             must not manufacture a breach, and must not excuse a qty breach.
//
// Config: env vars STOCK_TAKE_VARIANCE_QTY_LIMIT /
// STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN, absent-safe with the shipped defaults —
// the same wrangler.toml-[vars] idiom as COSTING_DISPLAY_ENABLED (parse once,
// never throw, a missing var can never change behaviour). Limits are clamped
// to >= 0; 0 is legal and means "every non-zero variance needs a supervisor".
// ----------------------------------------------------------------------------

export const DEFAULT_VARIANCE_QTY_LIMIT = 5;
export const DEFAULT_VARIANCE_VALUE_LIMIT_SEN = 50_000; // RM500

export type VarianceThresholds = {
  qtyLimit: number;
  valueLimitSen: number;
};

export interface VarianceThresholdEnv {
  STOCK_TAKE_VARIANCE_QTY_LIMIT?: string;
  STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN?: string;
}

const parseLimit = (raw: string | undefined, fallback: number): number => {
  if (raw == null) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

/** Absent / unparseable / negative → the shipped default. Never throws. */
export function parseVarianceThresholds(
  env: VarianceThresholdEnv | null | undefined,
): VarianceThresholds {
  return {
    qtyLimit: parseLimit(env?.STOCK_TAKE_VARIANCE_QTY_LIMIT, DEFAULT_VARIANCE_QTY_LIMIT),
    valueLimitSen: parseLimit(env?.STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN, DEFAULT_VARIANCE_VALUE_LIMIT_SEN),
  };
}

export type VarianceLine = {
  itemCode: string;
  /** SIGNED qty delta this line will post (counted − live). */
  adjustment: number;
  /** Best-known unit cost in SEN, or null when no basis exists (value rule skipped). */
  unitCostSen: number | null;
};

/**
 * The pure fold: which product codes breach the posting threshold?
 * Returns UNIQUE codes in first-seen order — the refusal names SKUs, and one
 * SKU with two variant buckets over the line is still one conversation.
 */
export function findVarianceBreaches(
  lines: ReadonlyArray<VarianceLine>,
  t: VarianceThresholds,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const absQty = Math.abs(l.adjustment);
    if (absQty === 0) continue;
    const qtyBreach = absQty > t.qtyLimit;
    const valueBreach =
      l.unitCostSen != null && l.unitCostSen > 0 && absQty * l.unitCostSen > t.valueLimitSen;
    if ((qtyBreach || valueBreach) && !seen.has(l.itemCode)) {
      seen.add(l.itemCode);
      out.push(l.itemCode);
    }
  }
  return out;
}

/**
 * The operator-facing refusal. Constraints inherited from the client filter
 * (humanApiError, frontend authed-fetch.ts): stay under 200 characters, no
 * braces, no bare five-digit numbers — so the value limit is stated in whole
 * RINGGIT and the SKU list is capped. Shape asserted in the route tests.
 */
export function formatVarianceRefusal(codes: ReadonlyArray<string>, t: VarianceThresholds): string {
  const shown = codes.slice(0, 3).join(', ') + (codes.length > 3 ? ` and ${codes.length - 3} more` : '');
  const rm = Math.round(t.valueLimitSen / 100);
  return `Variance over the posting limit (${t.qtyLimit} units or RM${rm} per line) on: ${shown}. A stock-take supervisor must post this count.`;
}
