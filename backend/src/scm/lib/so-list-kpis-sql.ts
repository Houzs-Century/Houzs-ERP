// ----------------------------------------------------------------------------
// so-list-kpis-sql — the Sales Order list's status pills, On Hold pill and
// money strip in TWO SQL statements, instead of paging every matching order.
//
// Production PostgREST has aggregates off, so GET /mfg-sales-orders?page= took
// the fallback: page the status column of the whole scoped set (about 12 round
// trips for 11,000 orders) and page the money columns of the whole filtered set
// (up to 12 more), one after another, plus a head count for On Hold. Here the
// SAME closures (`read.scoped`, `read.header`, the money skip-cancelled term)
// are compiled to SQL by pgrest-sql.ts and answered by Postgres directly.
//
// The numbers are the fallback's numbers, by construction:
//   - pills: the rows go through the same tallyStatusRows, weighted by count;
//   - On Hold: rows of the scoped set matching HELD_OR_TERM, as the head count;
//   - money: Σ local_total_sen, Σ (balance_sen_live ?? balance_sen),
//     Σ paid_total_sen — SUM skips NULL exactly as the `?? 0` reduce does.
// Returns null when the caller must use its PostgREST path (list-sql.ts).
// ----------------------------------------------------------------------------

import { HELD_OR_TERM } from './document-hold';
import { NOT_CANCELLED_OR } from './list-money-cancelled';
import { FRESH_READ, SqlParams, sqlIdent, whereOf, type SqlFilterRecorder } from './pgrest-sql';
import { trySql } from './list-sql';
import { tallyStatusRows, type StatusTally } from './status-counts';

type Apply = (q: SqlFilterRecorder) => unknown;

export type SoListKpiRead = {
  scoped: <T>(q: T) => T;
  header: <T>(q: T) => T;
  countFrom: 'mfg_sales_orders' | 'mfg_sales_orders_with_payment_totals';
};

export type SoListKpis = {
  counted: StatusTally;
  held: { ok: true; n: number };
  money: { revenueSen: number; outstandingSen: number; paidSen: number };
};

/** The two statements, built from the list's closures. Exported for the tests. */
export function soListKpiStatements(read: SoListKpiRead, moneySkipCancelled: boolean) {
  const cp = new SqlParams();
  const scopedWhere = whereOf(read.scoped as Apply, cp);
  const heldWhere = whereOf((q) => q.or(HELD_OR_TERM), cp);
  const counts = {
    text: `SELECT t.status, count(*)::bigint AS cnt, (count(*) FILTER (WHERE ${heldWhere}))::bigint AS held`
      + ` FROM scm.${sqlIdent(read.countFrom)} t WHERE ${FRESH_READ} AND ${scopedWhere} GROUP BY t.status`,
    values: cp.values,
  };
  const mp = new SqlParams();
  const moneyWhere = whereOf((q) => {
    const h = read.header(q);
    return moneySkipCancelled ? h.or(NOT_CANCELLED_OR) : h;
  }, mp);
  const money = {
    text: 'SELECT coalesce(sum(t.local_total_sen), 0)::bigint AS rev,'
      + ' coalesce(sum(coalesce(t.balance_sen_live, t.balance_sen)), 0)::bigint AS out,'
      + ' coalesce(sum(t.paid_total_sen), 0)::bigint AS paid'
      + ` FROM scm.mfg_sales_orders_with_payment_totals t WHERE ${FRESH_READ} AND ${moneyWhere}`,
    values: mp.values,
  };
  return { counts, money };
}

export function soListKpisFromRows(
  countRows: ReadonlyArray<{ status: string | null; cnt: number | string; held: number | string }>,
  moneyRow: { rev: number | string; out: number | string; paid: number | string } | undefined,
): SoListKpis {
  const rows = countRows.map((r) => ({ status: r.status, cnt: Number(r.cnt), held: Number(r.held) }));
  return {
    counted: tallyStatusRows({ data: rows, error: null }, (r) => r.cnt),
    held: { ok: true, n: rows.reduce((s, r) => s + r.held, 0) },
    money: {
      revenueSen: Number(moneyRow?.rev ?? 0),
      outstandingSen: Number(moneyRow?.out ?? 0),
      paidSen: Number(moneyRow?.paid ?? 0),
    },
  };
}

export function soListKpisSql(
  env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string },
  read: SoListKpiRead,
  moneySkipCancelled: boolean,
): Promise<SoListKpis | null> {
  return trySql(env, 'so-kpis', async (sql) => {
    const st = soListKpiStatements(read, moneySkipCancelled);
    const [countRows, moneyRows] = await Promise.all([
      sql.unsafe(st.counts.text, st.counts.values),
      sql.unsafe(st.money.text, st.money.values),
    ]);
    return soListKpisFromRows(
      countRows as unknown as Array<{ status: string | null; cnt: number; held: number }>,
      (moneyRows as unknown as Array<{ rev: number; out: number; paid: number }>)[0],
    );
  });
}
