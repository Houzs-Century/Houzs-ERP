// ----------------------------------------------------------------------------
// Confirm-screen "Auto-match" button — pure candidate selection.
//
// The button scans the customer's earlier sales orders and, if one can still
// back a cross-category delivery follow-up, fills its SO number in for sales
// (so they don't have to remember/type it). The DB query lives in the route;
// this is the pure decision over the rows it returns.
//
// "Same customer" uses the SAME identity key as migration 0144's customers
// table: (lower(trim(name)), phone). The caller filters by phone; this filters
// by name with the matching lower(trim) rule — a shared phone with a different
// name is a DIFFERENT customer (Chairman 2026-06-03), so it is NOT matched.
//
// Single-use: an SO already linked-from by another order (its doc_no appears in
// usedSourceDocNos) is skipped. The unique index on
// mfg_sales_orders.cross_category_source_doc_no (migration 0141) is the hard
// backstop; this just keeps the button from ever offering a burnt SO.
// ----------------------------------------------------------------------------

export interface AutoMatchCandidate {
  docNo: string;
  debtorName: string | null;
}

/** Identity-key normalisation — mirrors `lower(trim(name))` in the customers
 *  unique index (migration 0144). trim() = btrim() for the values we store. */
const nameKey = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * Pick the SO to auto-fill, or null when none qualifies.
 *
 * @param candidatesNewestFirst the customer's earlier SOs already filtered to
 *        their phone and to non-cancelled, ordered newest-first by the caller.
 * @param customerName the new order's customer name (the other half of the
 *        identity key); an empty name can't identify a customer → no match.
 * @param usedSourceDocNos doc_nos already used as a cross-category source by
 *        some other SO (single-use).
 */
export function pickCrossCategoryMatch(
  candidatesNewestFirst: AutoMatchCandidate[],
  customerName: string,
  usedSourceDocNos: Iterable<string>,
): AutoMatchCandidate | null {
  const wantName = nameKey(customerName);
  if (!wantName) return null;
  const used = new Set(usedSourceDocNos);
  for (const cand of candidatesNewestFirst) {
    if (nameKey(cand.debtorName) !== wantName) continue;  // different customer
    if (used.has(cand.docNo)) continue;                   // already used (single-use)
    return cand;                                          // newest qualifying wins
  }
  return null;
}
