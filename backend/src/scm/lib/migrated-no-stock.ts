/* company-scope-file: this module READS NOTHING and WRITES NOTHING. It answers
   one question about a header row the caller already loaded under its own
   company predicate. There is no statement here to carry one. */

/**
 * MIGRATED PAPERWORK — a POSTED document that posted no stock (migration 0276).
 *
 * The goods receipts and delivery orders carried over from AutoCount at the
 * 2026-08 cutover are real documents with **no inventory movement behind them,
 * deliberately**. On-hand entered the ERP once through the AutoCount BALANCE
 * SNAPSHOT, which already counts every past receipt as IN and every past
 * delivery as OUT. A movement behind one of these would apply the same units a
 * second time. Measured on production 2026-09-07 (Actions -> *GR shape check*):
 * 0 movement rows and 0 units behind all 320 migrated receipts of company 1.
 *
 * ── WHY THIS NEEDED A NAMED RULE, AND NOT JUST A COLUMN READ ────────────────
 *
 * There are two ways to build a stock correction in this codebase, and which
 * one a function uses is invisible from its name:
 *
 *   MOVEMENT-derived — read this document's own `inventory_movements` and write
 *     the opposite. SAFE BY CONSTRUCTION for a migrated document: zero rows in,
 *     zero rows out. `fn_reverse_do_out` (mig 0307) and `buildDoReversalRows`
 *     are both this shape, which is why the DO CANCEL path never needed a guard.
 *
 *   LINE-derived — read the document's LINES and write the opposite of what
 *     they say. WRONG for a migrated document: the lines say N units, the ledger
 *     says nothing, and the difference is written to the shelf.
 *     `buildGrnCancelReversals`, the GRN line/header edit paths, and
 *     `resyncInventoryForDo`'s `target − current_net_out` delta are all this
 *     shape. Every one of them needed this flag.
 *
 * ── THE GUARD THAT CANNOT SEE IT ────────────────────────────────────────────
 *
 * `grnReverseWouldGoNegative` asks whether the units are on hand. For a migrated
 * receipt they ARE — they arrived by the snapshot rather than by this document —
 * so it PASSES, and the phantom OUT is written with every guard reporting
 * satisfied. That is why the cancel path read as protected for a month. A guard
 * that answers a different question is worse than no guard, and it is the reason
 * this rule is a module with a name rather than five inline `=== true` checks.
 *
 * ── WHAT IS SUPPRESSED, AND WHAT IS NOT ─────────────────────────────────────
 *
 * STOCK ONLY. The PO `received_qty` recount, the audit row, the AutoCount
 * outbox enqueue and the header money recompute all still run on a migrated
 * document: it is real paperwork and it is allowed to be cancelled and edited
 * like any other. Only the movements are suppressed.
 *
 * Ledger: `docs/bugs/0675-a-migrated-goods-receipt-cancelled-reversing-879-units-it-ne.md`.
 * Guides: `docs/modules/grn.md` 5b, `docs/modules/delivery-order.md`.
 */

/** The header columns this rule reads. Optional because a database that has not
 *  applied migration 0276 has no such column, and absence must read as "not
 *  migrated" (the pre-cutover world), never as a crash. */
export type MigratedFlagRow = { migrated_no_stock?: boolean | null };

/**
 * TRUE when this document is AutoCount paperwork whose stock effect already
 * happened elsewhere — so no caller may post, un-post, relocate or correct
 * inventory on its behalf.
 *
 * Strict `=== true`, not truthiness: PostgREST can hand back the string
 * `'true'`/`'false'` for a boolean column through some shims, and `'false'` is
 * truthy. A wrong TRUE here silently disables a real reversal.
 */
export function isMigratedNoStock(row: MigratedFlagRow | null | undefined): boolean {
  return row?.migrated_no_stock === true;
}
