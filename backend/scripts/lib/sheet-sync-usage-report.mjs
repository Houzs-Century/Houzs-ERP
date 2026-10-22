// The HC Delivery sheet's endpoint-usage report: the SQL, and the rule that
// turns its rows into the owner's two verdicts.
//
// Lives in scripts/lib/ with NO shebang because tests import it — both the
// light suite (the verdict rule) and tests-pg (the SQL, against real
// Postgres). A probe whose SQL has never run cannot be trusted: a
// workflow_dispatch check only runs once it is merged, so the statement is
// proven on CI's postgres:16 first.

/** The owner's two thresholds, in days (2026-09-24). */
export const ISOLATE_AFTER = 30;
export const DELETE_DECISION_AFTER = 90;

/**
 * One SELECT. Per endpoint: the 7- and 30-day windows, the all-time totals,
 * the last day it was called, how long it has been idle, and how old the
 * table's own evidence is. Days are MALAYSIAN days — the sheet's daily 07:00
 * triggers are 23:00 UTC the day before, and a UTC day would split them.
 */
export const SHEET_USAGE_REPORT_SQL = `
  WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
       span  AS (SELECT MIN(day) AS since FROM scm.sheet_sync_usage)
  SELECT u.endpoint,
         SUM(u.calls)::bigint                                                   AS calls_all,
         SUM(u.rows_out)::bigint                                                AS rows_all,
         SUM(u.errors)::bigint                                                  AS errors_all,
         COALESCE(SUM(u.calls)    FILTER (WHERE u.day > t.d - 7), 0)::bigint    AS calls_7,
         COALESCE(SUM(u.rows_out) FILTER (WHERE u.day > t.d - 7), 0)::bigint    AS rows_7,
         COALESCE(SUM(u.calls)    FILTER (WHERE u.day > t.d - 30), 0)::bigint   AS calls_30,
         COALESCE(SUM(u.errors)   FILTER (WHERE u.day > t.d - 30), 0)::bigint   AS errors_30,
         MAX(u.day)                                                             AS last_day,
         (t.d - MAX(u.day))::int                                                AS days_idle,
         (t.d - s.since)::int                                                   AS table_age_days,
         s.since                                                                AS recording_since
  FROM scm.sheet_sync_usage u, today t, span s
  GROUP BY u.endpoint, t.d, s.since
  ORDER BY calls_30 DESC, u.endpoint`;

/**
 * The verdicts, and the guard that makes them honest: an endpoint idle for
 * longer than the table has EXISTED is not an idle endpoint, it is an endpoint
 * the table has never seen. Silence younger than the evidence is not evidence.
 *
 * @param {Array<{endpoint: string, days_idle: number, errors_30: number|string, calls_30: number|string}>} rows
 * @param {number} tableAgeDays
 * @returns {{ stale: string[], dead: string[], failing: string[] }}
 */
export function usageVerdicts(rows, tableAgeDays) {
  const idle = (n) => (tableAgeDays >= n ? rows.filter((r) => Number(r.days_idle) >= n) : []);
  const dead = idle(DELETE_DECISION_AFTER);
  const deadSet = new Set(dead.map((r) => r.endpoint));
  return {
    stale: idle(ISOLATE_AFTER)
      .filter((r) => !deadSet.has(r.endpoint))
      .map((r) => r.endpoint),
    dead: dead.map((r) => r.endpoint),
    failing: rows.filter((r) => Number(r.errors_30) > 0).map((r) => `${r.endpoint} ${r.errors_30}/${r.calls_30}`),
  };
}
