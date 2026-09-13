/* line-po-link — which purchase order a goods-receipt or purchase-invoice LINE
   came from, as the screens read it (#26, owner confirmed 2026-09-14: "GRN & PI
   need PO related show for every item — easier to cross check").

   The server resolves it per line from the line's own link
   (backend/src/scm/lib/line-po-ref.ts) and serves `source_po_id` +
   `source_po_number`. This file is the ONE place the desktop grids, the desktop
   editors and the phone decide whether a line has a PO to show — so a manual
   line reads the same "nothing" everywhere, and nobody falls back to the
   header's PO, which for a receipt spanning two orders is wrong for half the
   lines. */

export type LinePoFields = {
  source_po_id?: string | null;
  source_po_number?: string | null;
};

export type LinePoLink = { id: string; number: string };

export const linePoLink = (line: LinePoFields): LinePoLink | null => {
  const id = (line.source_po_id ?? '').trim();
  const number = (line.source_po_number ?? '').trim();
  return id && number ? { id, number } : null;
};

export const poDetailHref = (poId: string): string => `/scm/purchase-orders/${encodeURIComponent(poId)}`;
