// ----------------------------------------------------------------------------
// board-deliverable — the Delivery Planning board's delivery-progress fold.
//
// Lifted out of the route when its delivered-sum step grew an error path:
// delivery-planning.ts sits AT its file-size ceiling and may only shrink, and a
// fold is not a route. What it folds is the authoritative per-line map from
// soDeliverableRemaining — the same engine the DO convert flow reads, so the
// board can never disagree with an order's own remaining.
//
// It does NOT catch. The delivered-sum read fails loudly by design (see
// lib/do-unlinked-coverage.ts: a board that quietly reports nothing delivered is
// worse than one that errors), and since 2026-08-18 that throw carries its own
// operator-safe body via lib/read-failure.ts. The route catches it there.
//
// NOTE (not fixed here, by design): the SIZE of the `.in(...)` list this fold
// hands down through soDeliverableRemaining — every live SO on the board, which
// is what the request URI that gets rejected is made of — is owned by the
// chunking work on branch fix/unbounded-in-list-chunking.
// ----------------------------------------------------------------------------

import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';

/** Σ delivered / Σ remaining per SO doc_no.
 *
 *  eslint-disable-next-line @typescript-eslint/no-explicit-any — `sb` is the
 *  untyped supabase-js client this tree passes around. */
export async function boardDeliverableByDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNos: string[],
): Promise<{ deliveredByDoc: Map<string, number>; remainingByDoc: Map<string, number> }> {
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  /* soDeliverableRemaining excludes DRAFT / CANCELLED DOs already; an SO is
     fully delivered once every line's remaining == 0 AND at least one qty has
     shipped (delivered > 0). */
  for (const line of (await soDeliverableRemaining(sb, docNos)).values()) {
    deliveredByDoc.set(line.docNo, (deliveredByDoc.get(line.docNo) ?? 0) + line.delivered);
    remainingByDoc.set(line.docNo, (remainingByDoc.get(line.docNo) ?? 0) + line.remaining);
  }
  return { deliveredByDoc, remainingByDoc };
}
