// ----------------------------------------------------------------------------
// so-funnel-values-sql — the two whole-company reads behind
// GET /mfg-sales-orders/funnel-values, as two SQL statements.
//
// They used to be paged 1,000 rows at a time (pageWithTruncation): about 12
// sequential pages of the payment-totals view plus the book-number pages, ~25
// round trips per open. Same rows here: the caller's scope closure compiled by
// pgrest-sql.ts, the same columns in the same doc_no order, and the same 20-page
// ceiling — `truncated` is true exactly when the paged read would have filled
// all 20 pages. Null = the caller pages through PostgREST as before.
// ----------------------------------------------------------------------------

import { OUTSTANDING_MAX_PAGES, OUTSTANDING_PAGE } from './outstanding-po-lines';
import { FRESH_READ, SqlParams, selectCol, whereOf, type SqlFilterRecorder } from './pgrest-sql';
import { jsonRows, trySql } from './list-sql';

export type SqlEnv = { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string };

const CAP = OUTSTANDING_PAGE * OUTSTANDING_MAX_PAGES;

type Paged<T> = { data: T[]; error: null; truncated: boolean };

export function soFunnelStatements(cols: readonly string[], scope: (q: SqlFilterRecorder) => unknown) {
  const vp = new SqlParams();
  const viewWhere = whereOf(scope, vp);
  const bp = new SqlParams();
  const baseWhere = whereOf((q) => (scope(q) as SqlFilterRecorder).not('linked_ac_docno', 'is', null), bp);
  return {
    view: {
      text: `SELECT ${cols.map(selectCol).join(', ')} FROM scm.mfg_sales_orders_with_payment_totals t WHERE ${FRESH_READ} AND ${viewWhere} ORDER BY t.doc_no ASC LIMIT ${CAP}`,
      values: vp.values,
    },
    base: {
      text: `SELECT t.doc_no, t.linked_ac_docno FROM scm.mfg_sales_orders t WHERE ${FRESH_READ} AND ${baseWhere} ORDER BY t.doc_no ASC LIMIT ${CAP}`,
      values: bp.values,
    },
  };
}

export function soFunnelRowsSql<V, B>(
  env: SqlEnv,
  cols: readonly string[],
  scope: (q: SqlFilterRecorder) => unknown,
): Promise<{ view: Paged<V>; base: Paged<B> } | null> {
  return trySql(env, 'so-funnel-values', async (sql) => {
    const st = soFunnelStatements(cols, scope);
    const [view, base] = await Promise.all([
      jsonRows<V>(sql, st.view.text, st.view.values),
      jsonRows<B>(sql, st.base.text, st.base.values),
    ]);
    return {
      view: { data: view, error: null, truncated: view.length >= CAP },
      base: { data: base, error: null, truncated: base.length >= CAP },
    };
  });
}
