
/** The seven Outstanding modules, in display order. The summary always reports
 *  all seven keys — a module with no outstanding rows reports 0, never absent. */
export const OUTSTANDING_MODULES = [
  "po",
  "grn",
  "pi",
  "pr",
  "so",
  "do",
  "si",
] as const;

export type OutstandingModule = (typeof OUTSTANDING_MODULES)[number];

export interface OutstandingSummaryEntry {
  count: number;
  total_sen: number;
  total_outstanding_sen: number;
}

export type OutstandingSummary = Record<string, OutstandingSummaryEntry>;

/** A zeroed summary carrying all seven module keys — the exact shape the live
 *  path yields for an empty DB, so the snapshot path can never return FEWER
 *  keys than the live one and quietly hide a module from the dashboard. */
export function emptyOutstandingSummary(): OutstandingSummary {
  const summary: OutstandingSummary = {};
  for (const m of OUTSTANDING_MODULES) {
    summary[m] = { count: 0, total_sen: 0, total_outstanding_sen: 0 };
  }
  return summary;
}

/** One row of scm.mv_ar_aging as PostgREST returns it. bigint columns may arrive
 *  as a number or a numeric string depending on magnitude, so callers coerce
 *  with Number(); the columns are NOT NULL by construction (COUNT + the view's
 *  COALESCE(...,0)), so no `?? 0` crutch is needed or wanted. */
export interface AgingMvRow {
  module: string;
  cnt: number | string;
  total_sen: number | string;
  total_outstanding_sen: number | string;
}

/**
 * Reduce mv_ar_aging rows — ALREADY company-scoped by the caller's query — into
 * the per-module summary the endpoint returns.
 *
 * Rows are SUMMED per module. That matters for the UNRESOLVED / all-companies
 * case: the MV holds one row per (company_id, module), and a summary with no
 * active company must total ACROSS companies per module — exactly what the live
 * path's company-unfiltered SUM does. When the caller HAS scoped to one company
 * (.eq('company_id', X)), each module has at most one row, so the sum is a
 * pass-through. One reducer serves both, so the two shapes cannot drift.
 *
 * An unknown module label (not one of the seven) is ignored rather than
 * inventing an eighth key.
 */
export function reduceAgingSnapshot(rows: AgingMvRow[]): OutstandingSummary {
  const summary = emptyOutstandingSummary();
  for (const r of rows) {
    const entry = summary[r.module];
    if (!entry) continue;
    entry.count += Number(r.cnt);
    entry.total_sen += Number(r.total_sen);
    entry.total_outstanding_sen += Number(r.total_outstanding_sen);
  }
  return summary;
}
