/**
 * Is a document's latest approved amendment already CARRIED to AutoCount by an
 * edit row in the outbox? Used by scripts/requeue-amendment-ac-edits.mjs to
 * decide which documents it must NOT queue again.
 *
 * NO SHEBANG — imported by a test (CLAUDE.md).
 */

/** Statuses of an edit row that will reach, or has reached, AutoCount. */
export const CARRYING_STATUSES = new Set(["pending", "sent"]);
/**
 * How far BEFORE the approval stamp an edit row may be and still be the one the
 * approval queued.
 *
 * Both approve routes call enqueueEdit inside the transaction that stamps the
 * approval. `scm.autocount_outbox.created_at` is DEFAULT now(), which in
 * Postgres is the TRANSACTION START; `approved_at` / `so_approved_at` is a JS
 * timestamp taken near the END of that transaction. So the approval's own edit
 * is always OLDER than the approval, by the length of the transaction (seconds).
 * A strict `created_at > approved_at` never sees it — which is how the requeue
 * planned a second edit for all 14 approvals of 2026-09-14 08:49-08:58 UTC
 * (probe run 34826419283, window_edit=1 on each).
 *
 * Two minutes is the window check-amendment-ac-writeback.mjs measured with. What
 * it gives up, said plainly: an ORDINARY save committed within two minutes
 * before an approval that itself queued nothing would read as covering it. That
 * needs a pre-fix approval (after the fix every approval queues its own row) and
 * a second person saving the same document inside that window.
 */
export const SAME_TRANSACTION_WINDOW_MS = 2 * 60 * 1000;

/**
 * @param {{ docType: string, docNo: string, docId: string | null, lastApprovedAt: Date }} target
 * @param {Array<{ doc_type: string, doc_no: string | null, doc_id: string | null, op: string, status: string, created_at: Date }>} edits
 * @returns the covering row, newest first, or null
 */
export function coveringEdit(target, edits) {
  const mine = edits.filter((o) => o.op === "edit"
    && o.doc_type === target.docType
    && (o.doc_no === target.docNo || (target.docId != null && o.doc_id === target.docId))
    && CARRYING_STATUSES.has(o.status)
    && o.created_at.getTime() >= target.lastApprovedAt.getTime() - SAME_TRANSACTION_WINDOW_MS);
  mine.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return mine[0] ?? null;
}

/**
 * The ids of a document's still-keyless lines that an ADD amendment introduced —
 * the lines the write-back edit must declare NEW (docs/bugs/0943), or composeEdit
 * refuses the whole document as keyless and the amendment never reaches the book.
 *
 * A keyless line on an amended SO is either one an ADD amendment appended or a
 * backfill gap, and only the first is safe to declare new (declaring a
 * backfill-gap line new would APPEND a duplicate into a licensed book). So this
 * matches on the ADD amendment's own item codes and NEVER guesses from
 * keylessness alone. Item code, not row id, because so_amendment_lines does not
 * store the id of the mfg_sales_order_items row its ADD inserted.
 *
 * @param {Array<{ id: string, item_code: string | null }>} keylessLines live lines with no linked_ac_dtlkey
 * @param {Iterable<string | null>} addItemCodes new_item_code of the doc's ADD amendment lines
 * @returns {string[]} ids to pass to enqueueEdit as newLineIds
 */
export function keylessAddedLineIds(keylessLines, addItemCodes) {
  const codes = new Set([...addItemCodes].map((c) => String(c ?? "").trim()).filter(Boolean));
  if (codes.size === 0) return [];
  return keylessLines
    .filter((l) => codes.has(String(l.item_code ?? "").trim()))
    .map((l) => String(l.id));
}
