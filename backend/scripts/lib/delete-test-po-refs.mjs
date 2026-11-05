/* The SQL `scripts/delete-test-po.mjs` has to get right, in a library so CI's
 * postgres:16 runs it before production does — see
 * `tests-pg/deleteTestPoRefs.pg.test.ts`. Same shape as delete-test-so-refs.mjs.
 *
 *   1. WHO NAMES THIS PO?  A PO is named two ways: by its number (po_number,
 *      text) and by its uuid (purchase_order_id, po_id, doc_id, entity_id ...).
 *      Its LINES are named by their uuid too (grn_items.purchase_order_item_id).
 *      The sweep counts every candidate column in the live schema against all
 *      of them, and every hit is classified; an unclassified one refuses.
 *   2. IS IT LIVE?  Status, AutoCount, and anything posted refuse.
 *   3. DID ANYTHING ELSE MOVE?  A fingerprint of every OTHER purchase order.
 *
 * Everything here is a SELECT except nothing: the deletes are the script's, in
 * its transaction. CHILD_TABLES lives here only so the test can run the very
 * statements the script runs.
 */

/* Deleted with the PO, in this order (children of children first). Each `match`
   uses :id (the PO's uuid) and/or :no (its po_number); bindMatch() turns them
   into $n parameters. A table that is not in the database is skipped. */
export const CHILD_TABLES = [
  /* Attribution slices on the lines (migration 0235). FK CASCADE from the line
     would take them anyway; deleted first so the count is printed. */
  { table: "scm.purchase_order_item_allocations",
    match: "purchase_order_item_id IN (SELECT id FROM scm.purchase_order_items WHERE purchase_order_id = :id::uuid)" },
  /* PO amendment requests and their lines (migration 0194, CASCADE from the PO). */
  { table: "scm.po_amendment_lines",
    match: "amendment_id IN (SELECT id FROM scm.po_amendments WHERE po_id = :id::uuid)" },
  { table: "scm.po_amendments", match: "po_id = :id::uuid" },
  /* Snapshots of earlier revisions of THIS PO (migration 0080). No FK. */
  { table: "scm.po_revisions", match: "po_id = :id::uuid" },
  /* "Request cancellation" on the PO. The table also holds SO requests, which
     are left alone (the SO lesson, PR 5216). */
  { table: "scm.document_cancel_requests",
    match: "doc_type = 'PO' AND (doc_number = :no OR doc_key = :id)" },
  /* Older line table (2990s-full-schema.sql); absent on most databases. */
  { table: "scm.purchase_order_lines", match: "purchase_order_id = :id::uuid" },
  { table: "scm.purchase_order_items", match: "purchase_order_id = :id::uuid" },
];

/** `{ text, params }` for one CHILD_TABLES match, bound to this PO. */
export function bindMatch(match, po) {
  const params = [];
  const text = match.replace(/:(id|no)\b/g, (_, k) => {
    params.push(k === "id" ? String(po.id) : po.po_number);
    return `$${params.length}`;
  });
  return { text, params };
}

/* The RECORD that the PO existed. Kept on purpose, as on the SO side. */
export const AUDIT_KEEP = new Set([
  /* Append-only (migration 0277); the only proof of what the ERP sent to
     AutoCount. poBlockers() has already refused if anything there is unsent. */
  "scm.autocount_outbox",
  /* History drawer: entity_type 'PURCHASE_ORDER', entity_id = the PO's uuid. */
  "scm.entity_audit_log",
]);

/* A hit in one of these is a real downstream document, stock, money, or a link
   from another document, and refuses the run. */
export const DOWNSTREAM_TABLES = new Set([
  // Goods received against the PO (and everything that follows a GRN).
  "scm.grns",
  "scm.grn_items",
  "scm.po_receipt_so_assignments",
  "scm.purchase_invoices",
  "scm.purchase_invoice_items",
  "scm.purchase_returns",
  "scm.purchase_return_items",
  // Stock: a drop-ship DO OUT carries the PO number as batch_no.
  "scm.inventory_movements",
  // A delivery order line committed to this PO's batch (migration 0230).
  "scm.delivery_order_items",
  "scm.delivery_orders",
  // Posted money naming the PO.
  "scm.journal_entries",
  /* A product request linked to this PO (po_id, ON DELETE SET NULL). Refused
     until the owner rules whether the link may be dropped. */
  "scm.product_requests",
]);

export const CHILD = "child";
export const AUDIT = "audit";
export const DOWNSTREAM = "downstream";
export const UNCLASSIFIED = "unclassified";

const CHILD_NAMES = new Set(CHILD_TABLES.map((t) => t.table));

/** Which bucket a swept reference falls in. */
export function classifyReference(table) {
  if (CHILD_NAMES.has(table)) return CHILD;
  if (AUDIT_KEEP.has(table)) return AUDIT;
  if (DOWNSTREAM_TABLES.has(table)) return DOWNSTREAM;
  return UNCLASSIFIED;
}

/* The PO's own row is not a reference to itself (its linked_ac_docno can equal
   its po_number), but ANOTHER PO's row naming it is. Per row, not per column. */
export const PARENT_TABLE = "scm.purchase_orders";

/* Every candidate column in scm/public:
     · uuid columns, except a table's own `id` (a primary key is not a reference)
     · text columns named like a document number, a batch number, or an id
   Text columns are compared with the PO number AND the uuids, because several
   tables keep a uuid as text (autocount_outbox.doc_id, entity_audit_log.entity_id,
   document_cancel_requests.doc_key). */
export async function referenceColumns(db) {
  return db`
    SELECT c.table_schema AS schema, c.table_name AS "table", c.column_name AS "column",
           (c.data_type = 'uuid') AS is_uuid
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('scm', 'public')
       AND ((c.data_type = 'uuid' AND c.column_name <> 'id')
         OR (c.data_type IN ('text', 'character varying', 'character')
             AND (c.column_name ILIKE '%doc_no%' OR c.column_name ILIKE '%docno%'
                  OR c.column_name ILIKE '%doc_number%' OR c.column_name ILIKE '%po_number%'
                  OR c.column_name ILIKE '%po_no%' OR c.column_name ILIKE '%batch_no%'
                  OR c.column_name ~* '_id$' OR c.column_name IN ('doc_key', 'entity_id'))))
     ORDER BY 1, 2, 3`;
}

/**
 * Count every row in scm/public that names this PO or one of its lines.
 * A count that could not run comes back in `failed`, never as a zero.
 *
 * @param po {{id:string, po_number:string}}
 * @param lineIds {string[]} uuids of the PO's lines
 * @returns {Promise<{scanned:number, hits:{table:string,column:string,n:number}[], failed:{table:string,column:string,why:string}[]}>}
 */
export async function sweepReferences(db, po, lineIds, { timeout = "120s" } = {}) {
  const cols = await referenceColumns(db);
  const uuids = [String(po.id), ...lineIds.map(String)];
  const texts = [po.po_number, ...uuids].map((v) => v.trim().toLowerCase());
  await db.unsafe(`SET statement_timeout = '${timeout}'`);
  const hits = [];
  const failed = [];
  try {
    for (const r of cols) {
      const qualified = `${r.schema}.${r.table}`;
      const notItself = qualified === PARENT_TABLE ? ` AND id IS DISTINCT FROM $2::uuid` : "";
      const where = r.is_uuid
        ? `"${r.column}" = ANY($1::uuid[])`
        : `lower(btrim("${r.column}")) = ANY($1::text[])`;
      try {
        const [row] = await db.unsafe(
          `SELECT count(*)::int AS n FROM "${r.schema}"."${r.table}" WHERE ${where}${notItself}`,
          notItself ? [r.is_uuid ? uuids : texts, String(po.id)] : [r.is_uuid ? uuids : texts],
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

/* DRAFT was never sent anywhere and claims no SO quota. CANCELLED has already
   released its quota and queued the AutoCount cancel through the app. Anything
   else is a live order with a supplier. */
export const DELETABLE_STATUSES = new Set(["DRAFT", "CANCELLED"]);

/**
 * Reasons this PO is still live. READ-ONLY; the caller refuses on any entry.
 * `po` is the header row (status, linked_ac_docno, id, po_number).
 */
export async function poBlockers(db, po) {
  const out = [];
  const status = String(po.status ?? "").toUpperCase();
  if (!DELETABLE_STATUSES.has(status)) {
    out.push(
      `status=${po.status}. Only a DRAFT or CANCELLED PO is deleted. Cancel it in the app first ` +
      `(that releases the SO quota and tells AutoCount), then re-run.`,
    );
  }
  const has = async (t) => Boolean((await db.unsafe(`SELECT to_regclass('${t}') AS t`))[0].t);
  if (await has("scm.autocount_outbox")) {
    const rows = await db`
      SELECT op, status FROM scm.autocount_outbox
       WHERE doc_type = 'PO'
         AND (doc_id = ${String(po.id)} OR lower(btrim(doc_no)) = lower(btrim(${po.po_number})))
       ORDER BY created_at`;
    for (const r of rows.filter((x) => x.status === "pending" || x.status === "failed")) {
      out.push(`AutoCount outbox has a ${r.op} row still ${r.status}. Let it send (or resolve it) first.`);
    }
    const cancelSent = rows.some((x) => x.op === "cancel" && x.status === "sent");
    const createSent = rows.some((x) => x.op === "create_po" && x.status === "sent");
    if ((po.linked_ac_docno || createSent) && !cancelSent) {
      out.push(
        `AutoCount holds this PO (${po.linked_ac_docno ?? "create sent"}) and no cancel was sent. ` +
        `Cancel the PO in the app and wait for the cancel to send.`,
      );
    }
  } else if (po.linked_ac_docno) {
    out.push(`AutoCount holds this PO (${po.linked_ac_docno}) and the outbox cannot be read to prove it was cancelled.`);
  }
  return out;
}

/**
 * The CONTROL: every purchase order EXCEPT this one, before and after.
 * `moneyCol` is resolved by the caller and may be null.
 */
export async function controlSnapshot(client, poId, { moneyCol = null } = {}) {
  const [row] = await client.unsafe(
    `SELECT (SELECT count(*)::int FROM scm.purchase_orders WHERE id <> $1::uuid) AS po_rows,
            (SELECT md5(coalesce(string_agg(po_number || '|' || coalesce(status::text, ''), ',' ORDER BY po_number), ''))
               FROM scm.purchase_orders WHERE id <> $1::uuid) AS po_fingerprint,
            (SELECT count(*)::int FROM scm.purchase_order_items WHERE purchase_order_id <> $1::uuid) AS item_rows,
            ${moneyCol ? `(SELECT coalesce(sum("${moneyCol}"), 0)::text FROM scm.purchase_orders WHERE id <> $1::uuid)` : "NULL::text"} AS money_sum`,
    [String(poId)],
  );
  return row;
}

export const CONTROL_FIELDS = ["po_rows", "po_fingerprint", "item_rows", "money_sum"];

/** Which control fields differ. Empty means nothing else moved. */
export function controlDrift(before, after) {
  return CONTROL_FIELDS.filter((k) => String(before[k]) !== String(after[k]));
}

function firstLine(e) {
  return String(e && e.message ? e.message : e).split(/\r?\n/)[0];
}
