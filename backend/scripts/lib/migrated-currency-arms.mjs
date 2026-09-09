/* migrated-currency-arms — which tables the currency repair walks, and the KEY
 * each one is addressed by.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LITERALS IN THE SCRIPT. The first
 * production run of `repair-migrated-currency.mjs` printed a correct plan for
 * the purchase orders and then died on the sales orders with
 * `PostgresError: column "id" does not exist` (run 34140077540, 2026-09-07
 * 23:47+08). scm.purchase_orders is keyed by a uuid `id`; **scm.mfg_sales_orders
 * has no `id` column at all** — its key is `doc_no`, which every writer in the
 * tree already says (`ON CONFLICT (doc_no)`, and mfg_sales_order_items joins
 * `h.doc_no = i.doc_no`). One assumption, applied to two tables that do not
 * share it.
 *
 * That failure shape is the expensive one: the run had already done real work
 * and printed a real, correct number before the wrong assumption was reached, so
 * it reads like a working script that hit a blip. The guard below turns it into
 * a NAMED refusal before any statement is built.
 */

export const CURRENCY_ARMS = [
  { kind: "PO", table: "scm.purchase_orders", label: "purchase orders", docCol: "po_number", pk: "id" },
  { kind: "SO", table: "scm.mfg_sales_orders", label: "sales orders", docCol: "doc_no", pk: "doc_no" },
];

/** schema + table, split out of `scm.purchase_orders`. */
export function splitTable(qualified) {
  const [schema, table] = String(qualified).split(".");
  return { schema, table };
}

/**
 * Which of an arm's columns the database does NOT have.
 *
 * `cols` is the set of column names that table actually carries. Pure, so the
 * rule is testable without a database — which is the point: the bug this exists
 * for was a wrong belief about a column, and a belief is exactly what a unit
 * test can hold to account.
 */
export function missingColumns(arm, cols) {
  const need = [arm.pk, arm.docCol, "currency", "linked_ac_docno", "company_id"];
  return [...new Set(need)].filter((c) => !cols.has(c));
}
