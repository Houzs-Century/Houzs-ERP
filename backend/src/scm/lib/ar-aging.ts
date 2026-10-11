// ----------------------------------------------------------------------------
// AR aging snapshot — the pure core shared by GET /outstanding/summary's live
// path and its ?snapshot=1 fast path (backed by the scm.mv_ar_aging
// materialized view, migration 0151).
//
// WHY A SNAPSHOT AT ALL. The summary loops seven Outstanding modules and, per
// module, SUMs/counts every outstanding doc (scm-scaling-audit.md flagged it as
// "the worst time-bomb": is_outstanding is a computed CASE column, not
// indexable, so each module is a full scan). Correct today; O(rows) as debtor
// data grows. The materialized view pre-computes exactly that rollup, one row
// per (company_id, module), refreshed nightly.
//
// WHY THIS FILE IS DEPENDENCY-FREE. The MV SQL itself can only be exercised
// against Postgres, and the vitest harness runs on an isolated SQLite D1 that
// never applies migrations-pg. So the SQL-vs-live byte-equality is verified by a
// staging before/after diff (perf-optimization-plan.md rule 2), and the parts
// that CAN be unit-tested — the reduce + the always-seven-keys shape — live here
// where a test can reach them without a database.
// ----------------------------------------------------------------------------

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
  total_centi: number;
  total_outstanding_centi: number;
}

export type OutstandingSummary = Record<string, OutstandingSummaryEntry>;

/** A zeroed summary carrying all seven module keys — the exact shape the live
 *  path yields for an empty DB, so the snapshot path can never return FEWER
 *  keys than the live one and quietly hide a module from the dashboard. */
export function emptyOutstandingSummary(): OutstandingSummary {
  const summary: OutstandingSummary = {};
  for (const m of OUTSTANDING_MODULES) {
    summary[m] = { count: 0, total_centi: 0, total_outstanding_centi: 0 };
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
  total_centi: number | string;
  total_outstanding_centi: number | string;
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
    entry.total_centi += Number(r.total_centi);
    entry.total_outstanding_centi += Number(r.total_outstanding_centi);
  }
  return summary;
}
