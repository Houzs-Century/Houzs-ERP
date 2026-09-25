// The SQL behind scripts/backfill-do-si-ref.mjs, kept here (no shebang) so
// tests-pg/backfillDocRef.pg.test.ts runs the exact statements the script runs.
//
// A DO / SI row is FILLABLE when its own `ref` is empty, its Sales Order (same
// doc_no AND same company) has a `ref`, and the row does not already hold a
// DIFFERENT reference in `customer_so_no`. Filling it copies the SO's ref.
// A row whose customer_so_no disagrees with the SO is a CONFLICT and is never
// written: which of the two is right is a person's call, not a script's.

export const DOC_TABLES = ['delivery_orders', 'sales_invoices'];

const joinSo = (t) => `
  FROM scm.${t} d
  JOIN scm.mfg_sales_orders s ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
 WHERE nullif(btrim(d.ref), '') IS NULL
   AND nullif(btrim(s.ref), '') IS NOT NULL`;

const agrees = `(nullif(btrim(d.customer_so_no), '') IS NULL OR btrim(d.customer_so_no) = btrim(s.ref))`;

/** { fillable, conflict } for one table. Counts only: the repo's Actions logs are public. */
export const countSql = (t) => `
  SELECT count(*) FILTER (WHERE ${agrees})::int AS fillable,
         count(*) FILTER (WHERE NOT ${agrees})::int AS conflict
  ${joinSo(t)}`;

/** Fill every fillable row of one table; returns the ids written. Re-running
 *  finds nothing: a filled row no longer has an empty ref. */
export const fillSql = (t) => `
  UPDATE scm.${t} d SET ref = btrim(s.ref)
    FROM scm.mfg_sales_orders s
   WHERE s.doc_no = d.so_doc_no AND s.company_id = d.company_id
     AND nullif(btrim(d.ref), '') IS NULL
     AND nullif(btrim(s.ref), '') IS NOT NULL
     AND ${agrees}
  RETURNING d.id::text AS id`;

/** Written rows whose ref does not now equal their SO's ref: must be 0. */
export const mismatchSql = (t) => `
  SELECT count(*)::int AS n
    FROM scm.${t} d
    JOIN scm.mfg_sales_orders s ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
   WHERE d.id::text = ANY($1::text[])
     AND d.ref IS DISTINCT FROM btrim(s.ref)`;
