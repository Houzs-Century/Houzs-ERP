/* ONE derivation of the Sales-Order list's "PO No." cell, shared by the desktop
   column (pages/scm-v2/MfgSalesOrdersListV2.tsx) and the mobile Orders card
   (mobile/MobileSalesOrders.tsx). Desktop and mobile are one product: the two
   surfaces may DRESS the chips differently (the desktop cell caps and shows a
   "+N", the phone card wraps) but they must never disagree about WHICH purchase
   orders a sales order has.

   Two arms, deliberately kept apart because they answer different questions:

     source  `source_po_union` — where the goods actually come from (shipped
             consumed batches ∪ READY FIFO projections, the shared backend
             resolver `unionSoLineChips`). Solid chip.
     raised  `converted_po_nos` — the purchase orders this SO's lines were
             converted INTO (`purchase_order_items.so_item_id`). Procurement
             provenance. Muted chip.

   Why `raised` is visible again (2026-08-11). Both source arms need EXECUTION:
   the shipped arm needs a Delivery Order line, the READY arm needs an open lot
   that still resolves to a PO. A CONFIRMED, not-yet-shipped order with
   unallocated stock satisfies neither, so the cell rendered "—" for documents
   whose own Relationship Map named a purchase order. Measured on production:
   of 2,723 Houzs Century sales orders only ~53 can light the source arms at
   all, while 277 carry a real non-cancelled PO on the line link. A tooltip on
   an em-dash is not an answer — if a link exists, a chip must show.

   `raised` is filtered against `source` so a PO that is already the goods
   source is never chipped twice. CANCELLED purchase orders are dropped
   backend-side (scm/lib/so-converted-po.ts), so nothing here re-checks status. */

export type SoPoChipRow = {
  source_po_union?: string[] | null;
  converted_po_nos?: string[] | null;
  source_po_adj?: boolean;
};

/** Desktop cell cap. Many-POs-to-one-SO is real (12 Houzs SOs carry 2, one
    carries 3, and shipped orders can add more), so the cell shows this many and
    then says how many are hidden — it never renders only the first in silence. */
export const PO_CELL_MAX = 3;

export function poCellChips(r: SoPoChipRow): { source: string[]; raised: string[]; all: string[] } {
  const source = (r.source_po_union ?? []).filter(Boolean);
  const raised = (r.converted_po_nos ?? []).filter((n) => Boolean(n) && !source.includes(n));
  return { source, raised, all: [...source, ...raised] };
}
