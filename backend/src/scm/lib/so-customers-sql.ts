// ----------------------------------------------------------------------------
// so-customers-sql — GET /mfg-sales-orders/customers' order read in ONE
// statement. It used to page every order of the company 1,000 rows at a time
// (about 11 sequential round trips at 11,000 orders) before grouping in JS.
//
// Same rows: the route's own scope closure (sales scope + company) compiled by
// pgrest-sql.ts, the same columns, `so_date DESC` first (doc_no only breaks the
// ties the paged read left in arbitrary order), and the paged read's 50-page
// ceiling. Null = the caller pages through PostgREST as before.
// ----------------------------------------------------------------------------

import { FRESH_READ, SqlParams, selectCol, whereOf, type SqlFilterRecorder } from './pgrest-sql';
import { jsonRows, trySql } from './list-sql';

export const SO_CUSTOMER_COLS = 'doc_no, status, on_hold, debtor_name, phone, local_total_sen, created_at, so_date, line_count';
/* paginateAll's ceiling: 50 pages of 1,000. */
const MAX_ROWS = 50_000;

export function soCustomerRowsStatement(scope: (q: SqlFilterRecorder) => unknown) {
  const p = new SqlParams();
  const where = whereOf(scope, p);
  return {
    text: `SELECT ${SO_CUSTOMER_COLS.split(', ').map(selectCol).join(', ')} FROM scm.mfg_sales_orders t WHERE ${FRESH_READ} AND ${where} ORDER BY t.so_date DESC, t.doc_no ASC LIMIT ${MAX_ROWS}`,
    values: p.values,
  };
}

export function soCustomerRowsSql<T>(
  env: { HYPERDRIVE?: { connectionString: string }; DATABASE_URL?: string },
  scope: (q: SqlFilterRecorder) => unknown,
): Promise<T[] | null> {
  return trySql(env, 'so-customers', (sql) => {
    const st = soCustomerRowsStatement(scope);
    return jsonRows<T>(sql, st.text, st.values);
  });
}
