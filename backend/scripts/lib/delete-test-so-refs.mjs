/* The two questions `scripts/delete-test-so.mjs` has to answer with SQL, in a
 * library so a real Postgres can run them before production does.
 *
 *   1. WHO NAMES THIS DOCUMENT?  Every text column in the live schema whose
 *      name could hold a document number, counted against one doc_no. The
 *      script's hand-written CHILD_TABLES list decides what gets DELETED; this
 *      decides whether deleting is safe at all.
 *   2. DID ANYTHING ELSE MOVE?  A fingerprint of every sales order EXCEPT this
 *      one, taken before the write and again on a fresh connection after it.
 *
 * WHY IT IS A LIBRARY AND NOT INLINE. `delete-test-so.mjs` opens a database in
 * its first ten lines, so there is no local run of it: `node --check` is all the
 * evidence it can have before it is pointed at production. That was not enough
 * for `probe-undated-demand.mjs`, which died mid-dispatch on SQL only Postgres
 * could have rejected, and it is not enough for a DELETE. Split out, the
 * statements run in CI's postgres:16 service — see
 * `tests-pg/deleteTestSoRefs.pg.test.ts`.
 *
 * The SECOND reason is the one docs/bugs/0711 bought: a helper's return shape is
 * invisible until it is called. `sweepReferences` returns
 * `{ scanned, hits, failed }` and `hits` is an ARRAY of objects — named here,
 * asserted in the test, so no caller has to infer it.
 *
 * READ-ONLY. Every statement is a SELECT. Nothing here writes, and nothing here
 * is allowed to: the caller is a delete, and a "helper" that wrote would put a
 * write outside the caller's transaction.
 */

/* A reference in one of these is the RECORD that the document existed, and it
   is meant to survive the delete. scm.autocount_outbox is append-only by design
   (migration 0277's COMMENT says rows are never removed; the 2026-09-08 archive
   migration added a COLUMN precisely so nothing would be), and it is the only
   durable proof that the ERP created an order and sent it to the account book.
   Deleting it destroys exactly the evidence that tells the next person whether
   a copy is still sitting in AutoCount. */
export const AUDIT_KEEP = new Set([
  "scm.autocount_outbox",
  /* The sales-order audit log — `so_doc_no, action, actor_id,
     actor_name_snapshot, field_changes, status_snapshot, source, note`
     (2990s-full-schema.sql:727). It holds the CREATE row that says who made the
     order and from where, and on 2026-09-08 that row is what identified
     HC-SO-2609-001 as a test rather than a customer's order in the first place.
     Deleting the order is the owner's instruction; erasing the record that
     somebody made it is not, and the two are not the same act.

     It was NOT on any list until the sweep found it (run 34220446297) — which
     is the whole reason the sweep exists, and why it refuses rather than
     cascading into a table nobody has thought about. */
  "scm.mfg_so_audit_log",
  "scm.entity_audit_log",
]);

/* A hit in one of these is a real downstream DOCUMENT and refuses the run. The
   two that `delete-test-so.mjs` also probes by name are listed here as well, so
   the sweep's verdict and the probe's verdict cannot drift apart. */
export const DOWNSTREAM_TABLES = new Set([
  "scm.consignment_notes",
  "scm.delivery_order_items",
  "scm.delivery_orders",
  "scm.delivery_returns",
  "scm.purchase_order_item_allocations",
  "scm.purchase_order_items",
  "scm.purchase_orders",
  "scm.sales_invoice_items",
  "scm.sales_invoices",
]);

export const CHILD = "child";
export const AUDIT = "audit";
export const DOWNSTREAM = "downstream";
export const UNCLASSIFIED = "unclassified";

/** Which bucket a swept reference falls in. `childTables` is a Set of qualified names. */
export function classifyReference(table, childTables) {
  if (childTables.has(table)) return CHILD;
  if (AUDIT_KEEP.has(table)) return AUDIT;
  if (DOWNSTREAM_TABLES.has(table)) return DOWNSTREAM;
  return UNCLASSIFIED;
}

/* THE PARENT'S OWN ROW IS NOT A REFERENCE TO ITSELF, and the distinction is
   per-ROW, not per-column. The first draft excluded only
   `scm.mfg_sales_orders.doc_no` and then reported
   `scm.mfg_sales_orders.linked_ac_docno` as an unclassified reference —
   run 34220446297 — because the account book took our own number, so
   `linked_ac_docno` equals `doc_no` on the very row being deleted.

   Excluding the COLUMN would have been the wrong repair: a DIFFERENT sales
   order carrying this one's number in `linked_ac_docno` is a real and
   dangerous reference, and that is exactly what would have been silenced. So
   the parent table is scanned with the row itself excluded instead, and every
   other row still counts. */
export const PARENT_TABLE = "scm.mfg_sales_orders";
export const PARENT_COL = "doc_no";

/** Every candidate column in the live schema. One statement, no writes. */
export async function referenceColumns(db) {
  return db`
    SELECT c.table_schema AS schema, c.table_name AS "table", c.column_name AS "column"
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('scm', 'public')
       AND c.data_type IN ('text', 'character varying', 'character')
       AND (c.column_name ILIKE '%doc_no%' OR c.column_name ILIKE '%docno%'
            OR c.column_name ILIKE '%doc_number%')
     ORDER BY 1, 2, 3`;
}

/**
 * Count every row anywhere in scm/public that names `docNo`.
 *
 * A count that could not RUN must never look like a zero — that is the exact
 * shape of the payments guard `delete-test-so.mjs` already refuses on. Failures
 * come back in `failed`, separately from `hits`, and the caller refuses on them.
 *
 * @returns {Promise<{scanned:number, hits:{table:string,column:string,n:number}[], failed:{table:string,column:string,why:string}[]}>}
 */
export async function sweepReferences(db, docNo, { timeout = "120s" } = {}) {
  const cols = await referenceColumns(db);
  await db.unsafe(`SET statement_timeout = '${timeout}'`);
  const hits = [];
  const failed = [];
  try {
    for (const r of cols) {
      const qualified = `${r.schema}.${r.table}`;
      if (qualified === PARENT_TABLE && r.column === PARENT_COL) continue;
      // On the parent table, skip the row being deleted; count every other one.
      const notItself = qualified === PARENT_TABLE
        ? ` AND lower(btrim("${PARENT_COL}")) IS DISTINCT FROM lower(btrim($1))`
        : "";
      try {
        const [row] = await db.unsafe(
          `SELECT count(*)::int AS n FROM "${r.schema}"."${r.table}"
            WHERE lower(btrim("${r.column}")) = lower(btrim($1))${notItself}`,
          [docNo],
        );
        if (row.n > 0) hits.push({ table: qualified, column: r.column, n: row.n });
      } catch (e) {
        failed.push({ table: qualified, column: r.column, why: firstLine(e) });
      }
    }
  } finally {
    await db.unsafe("SET statement_timeout = DEFAULT");
  }
  return { scanned: cols.length, hits, failed };
}

/**
 * The CONTROL. "Nothing else moved" is a claim, and a row count of the thing you
 * deleted is not evidence for it. This fingerprints the whole sales-order corpus
 * EXCLUDING one document, so before and after can be compared field by field.
 *
 * `moneyCol` and `payCol` are resolved by the caller against the LIVE schema and
 * may be null; a column that is not there yields null rather than a wrong sum.
 *
 * `status` IS AN ENUM (`scm.mfg_so_status`), NOT TEXT, and it must be cast
 * before it is concatenated: `coalesce(status, '')` asks Postgres to read '' as
 * a member of that enum and it answers
 * `invalid input value for enum scm.mfg_so_status: ""`. That is not a
 * hypothetical — it is what run 34223295235 died on, in plan mode, against
 * production. The pg fixture declared the column as `text`, which is MORE
 * PERMISSIVE than the real schema, so the suite passed on SQL production
 * rejects; the fixture now creates the enum. A fixture looser than production
 * proves nothing about production.
 */
export async function controlSnapshot(client, docNo, { moneyCol = null, payCol = null } = {}) {
  const [row] = await client.unsafe(
    `SELECT (SELECT count(*)::int FROM scm.mfg_sales_orders WHERE doc_no <> $1) AS so_rows,
            (SELECT md5(coalesce(string_agg(doc_no || '|' || coalesce(status::text, ''), ',' ORDER BY doc_no), ''))
               FROM scm.mfg_sales_orders WHERE doc_no <> $1) AS so_fingerprint,
            (SELECT count(*)::int FROM scm.mfg_sales_order_items WHERE doc_no <> $1) AS item_rows,
            ${payCol ? `(SELECT count(*)::int FROM scm.mfg_sales_order_payments WHERE "${payCol}" <> $1)` : "NULL::int"} AS pay_rows,
            ${moneyCol ? `(SELECT coalesce(sum("${moneyCol}"), 0)::text FROM scm.mfg_sales_orders WHERE doc_no <> $1)` : "NULL::text"} AS money_sum`,
    [docNo],
  );
  return row;
}

/** The fields `controlSnapshot` returns, so a comparison cannot silently skip one. */
export const CONTROL_FIELDS = ["so_rows", "so_fingerprint", "item_rows", "pay_rows", "money_sum"];

/** Which control fields differ between two snapshots. Empty means nothing else moved. */
export function controlDrift(before, after) {
  return CONTROL_FIELDS.filter((k) => String(before[k]) !== String(after[k]));
}

function firstLine(e) {
  return String(e && e.message ? e.message : e).split(/\r?\n/)[0];
}
