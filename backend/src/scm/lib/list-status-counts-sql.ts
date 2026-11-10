// ----------------------------------------------------------------------------
// list-status-counts-sql — a list's filter pills in ONE grouped statement.
//
// The bucket lists (Purchase Invoices today) ran one `count: 'exact', head: true`
// query per pill — seven for the PI list — each a full scan of the scoped set.
// Here the scoped set is grouped by status once, and each pill is summed from
// the groups:
//   - 'all'      every row (as the unfiltered head count),
//   - string[]   rows whose status is EXACTLY one of these (as `.in('status')`;
//                a NULL status matches none, as it never matched `.in`),
//   - 'held'     rows matching HELD_OR_TERM (as `.or(HELD_OR_TERM)`), counted
//                with FILTER in the same statement because it is a column, not
//                a status.
// The result has the same keys in the same order as readStatusCounts'.
// Null = the caller runs its per-pill head counts as before (list-sql.ts).
// ----------------------------------------------------------------------------

import { HELD_OR_TERM } from './document-hold';
import { FRESH_READ, SqlParams, sqlIdent, whereOf, type SqlFilterRecorder } from './pgrest-sql';
import { trySql } from './list-sql';
import type { SqlEnv } from './so-funnel-values-sql';

export type PillSpec = 'all' | 'held' | readonly string[];

export function statusCountsStatement(table: string, scope: (q: SqlFilterRecorder) => unknown) {
  const p = new SqlParams();
  const where = whereOf(scope, p);
  const held = whereOf((q) => q.or(HELD_OR_TERM), p);
  return {
    text: `SELECT t.status::text AS status, count(*)::bigint AS cnt, (count(*) FILTER (WHERE ${held}))::bigint AS held`
      + ` FROM scm.${sqlIdent(table)} t WHERE ${FRESH_READ} AND ${where} GROUP BY t.status`,
    values: p.values,
  };
}

export function pillsFromGroups<K extends string>(
  groups: ReadonlyArray<{ status: string | null; cnt: number | string; held: number | string }>,
  pills: ReadonlyArray<readonly [K, PillSpec]>,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const [key, spec] of pills) {
    let n = 0;
    for (const g of groups) {
      if (spec === 'all') n += Number(g.cnt);
      else if (spec === 'held') n += Number(g.held);
      else if (g.status !== null && spec.includes(g.status)) n += Number(g.cnt);
    }
    out[key] = n;
  }
  return out;
}

export function listStatusCountsSql<K extends string>(
  env: SqlEnv,
  label: string,
  table: string,
  scope: (q: SqlFilterRecorder) => unknown,
  pills: ReadonlyArray<readonly [K, PillSpec]>,
): Promise<{ ok: true; counts: Record<K, number> } | null> {
  return trySql(env, label, async (sql) => {
    const st = statusCountsStatement(table, scope);
    const rows = await sql.unsafe(st.text, st.values);
    return { ok: true as const, counts: pillsFromGroups(rows as unknown as Array<{ status: string | null; cnt: number; held: number }>, pills) };
  });
}
