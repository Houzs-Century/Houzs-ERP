// ----------------------------------------------------------------------------
// current-doc — shared "latest event wins" picker for the Current-document
// indicator (Wei Siang 2026-05-31).
//
// "Current" answers: which document has the flow reached right now. Given a set
// of downstream flow events that each carry a business date, a created_at
// tie-breaker, a corrective-action rank, and the parent document number, this
// returns the document NUMBER of the single furthest-forward event. It mirrors
// the exact ordering used by the status-badge lifecycle engines
// (computeSoLifecycle / computeDoLifecycle), so the "Current" number can never
// disagree with the status badge.
//
// Read-only display aid — no writes.
// ----------------------------------------------------------------------------

export type CurrentEvent = {
  date: string;       // business date ('YYYY-MM-DD' or full ISO); '' if unknown
  createdAt: string;  // ISO timestamp tie-breaker; '' if unknown
  rank: number;       // corrective-action priority for same-instant ties
  docNumber: string;  // the document number this event belongs to
};

/* Normalize mixed plain-date / ISO-timestamp business dates to a single
   day-level key (both share the leading 'YYYY-MM-DD'). Matches normalizeEventDay
   in delivery-orders-mfg.ts so Current and the badge sort identically. */
const normDay = (d: string): string => (d ?? '').slice(0, 10);

/* Pick the winning event's document number. Compare on day, tie-break by
   created_at, then by corrective-action rank. Returns null for an empty list. */
export function pickLatestDocNo(events: CurrentEvent[]): string | null {
  let best: CurrentEvent | null = null;
  for (const ev of events) {
    if (!best) { best = ev; continue; }
    const dc = normDay(ev.date).localeCompare(normDay(best.date));
    if (dc > 0) { best = ev; continue; }
    if (dc < 0) continue;
    const cc = ev.createdAt.localeCompare(best.createdAt);
    if (cc > 0) { best = ev; continue; }
    if (cc < 0) continue;
    if (ev.rank > best.rank) best = ev;
  }
  return best ? best.docNumber : null;
}

/* Collapse a keyed event bucket into Map<key, currentDocNumber>. Keys with no
   events are simply absent — the caller falls back to the document's own number
   (the flow has not moved past it yet). */
export function currentDocNoByKey(
  byKey: Map<string, CurrentEvent[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, evs] of byKey) {
    const docNo = pickLatestDocNo(evs);
    if (docNo) out.set(key, docNo);
  }
  return out;
}
