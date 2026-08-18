/* ---------------------------------------------------------------------------
   customer-ref — the ONE rule for the customer's own reference on a sales
   document, resolved the same way on every relationship map.

   THE BUG THIS CLOSES. Four builders resolved this cell with THREE different
   fallback orders:
     sales-doc-relationship-map.ts  buildDoChainNodes  po_doc_no || customer_so_no
     sales-doc-relationship-map.ts  buildSiChainNodes  customer_so_no || po_doc_no
     sales-doc-relationship-map.ts  buildDrChainNodes  customer_so_no only
     so-relationship-map.ts         useSoRelationshipMap  po_doc_no || customer_so_no || ref
   So for one order carrying both, the DO map's "Customer PO" node and the SI
   map's could disagree.

   THE ORDER IS FROM THE DATA + THE OWNER'S RULING (2026-08-18). Audited on
   scm.mfg_sales_orders: `ref` is the customer's reference and is the filled
   value on 2717 orders. `customer_so_no` is a near-duplicate carrying the SAME
   value plus 6 junk rows (test strings, and 2 rows where a source SO number was
   hand-typed into it) — the owner ruled `ref` is the correct field and
   `customer_so_no` is not needed. `po_doc_no` / `customer_po*` are 0%-filled
   dead columns. So `ref` LEADS; `customer_so_no` is a transitional fallback
   until it is retired, and `po_doc_no` a dead one that never fires on live data
   but stays so any legacy row that only carried it still renders.

   This is the DISPLAY rule only. The dead columns themselves are dropped in a
   separate, higher-risk migration (they are projected by a view — see the
   batch-2 plan). Registering `po_doc_no`/`customer_po` in the vocabulary guard
   waits for that drop, because the backend router still selects them until then.
   --------------------------------------------------------------------------- */

/** A sales-document header, as much of it as this rule reads. Structural so the
 *  DO / SI / DR / SO header types all satisfy it. */
export type CustomerRefHeader = {
  customer_so_no?: string | null;
  po_doc_no?: string | null;
  ref?: string | null;
};

/** The customer's own reference to show for a sales document. Empty string when
 *  none is recorded — callers decide how to render that (e.g. "Not linked"). */
export function customerRefOf(header: CustomerRefHeader | null | undefined): string {
  return (header?.ref || header?.customer_so_no || header?.po_doc_no || '').trim();
}
