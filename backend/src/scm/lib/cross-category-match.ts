
export interface AutoMatchCandidate {
  docNo: string;
  debtorName: string | null;
}

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
    if (nameKey(cand.debtorName) !== wantName) continue;
    if (used.has(cand.docNo)) continue;
    return cand;
  }
  return null;
}
