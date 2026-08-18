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

   THE ORDER IS FROM THE DATA, not taste. Audited against production 2026-08-18
   on scm.mfg_sales_orders: `customer_so_no` is the filled value (96%),
   `po_doc_no` / `customer_po` are 0%-filled dead columns, and `ref` is a filled
   duplicate of `customer_so_no`. So `customer_so_no` leads; the rest are
   fallbacks that never fire on live data but stay so legacy/native rows that
   only carried the old columns still render.

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
  return (header?.customer_so_no || header?.po_doc_no || header?.ref || '').trim();
}
