// ----------------------------------------------------------------------------
// arrangement-sort — the arrangement queues' default ordering (owner 2026-08-07:
// "跟着 delivery date、state、postcode 去排，这样排下来比较整齐").
//
// On entry, BOTH arrangement queues — the Delivery Date Arrangement page's
// "Date arrangement queue" (AutoSchedule.tsx) and the Delivery Time Arrangement
// inbox (Trips.tsx), each on BOTH of its sides (pending and arranged) — order
// their rows by, in priority:
//
//   1. the row's delivery date, OLDEST first (ascending); rows with no date
//      at all sink to the BOTTOM (a missing date must never outrank a real one),
//   2. then customer state, A→Z (blanks last),
//   3. then postcode, A→Z (blanks last).
//
// "Delivery date" here is the row's EFFECTIVE date — the same fallback chain
// ScheduleTripDrawer's "Propose dates" uses and what Days Left / OVERDUE run
// on: effective_delivery_date (server-derived = amended ?? original), falling
// through to amended_delivery_date ?? customer_delivery_date defensively for a
// cached pre-derivation payload. So the Pending-Date side (amended date still
// null by definition) orders by the customer's original requested date, and the
// Pending-Time / arranged sides order by the confirmed date.
//
// This is a DEFAULT, not a lock: it applies only while no column sort is
// active. A header the operator clicks overrides as always, and cycling the
// header back to "off" returns here rather than to raw fetch order.
//
// Pure and shared so the two pages can never drift apart; the rule is pinned
// by arrangement-sort.test.ts.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from './delivery-planning-queries';

/** The comparator reads only these fields, so tests (and any future caller)
 *  can build rows without the full PlanningOrder shape. */
export type ArrangementSortRow = Pick<
  PlanningOrder,
  | 'effective_delivery_date'
  | 'amended_delivery_date'
  | 'customer_delivery_date'
  | 'customer_state'
  | 'postcode'
>;

/** The delivery date the queues order on. Truncated to the calendar day
 *  (YYYY-MM-DD) so a stray timestamp value still ties with a date-only row on
 *  the same day and falls through to the state/postcode keys, keeping same-day
 *  rows tidily grouped. null = no date signal at all. */
export function arrangementDateOf(o: ArrangementSortRow): string | null {
  const d = o.effective_delivery_date ?? o.amended_delivery_date ?? o.customer_delivery_date;
  if (d == null) return null;
  const day = String(d).slice(0, 10);
  return day || null;
}

/* One ascending key: blank/null LAST, otherwise case-insensitive A→Z.
   ISO YYYY-MM-DD dates compare correctly under plain string comparison. */
function cmpBlankLast(a: string | null | undefined, b: string | null | undefined): number {
  const av = (a ?? '').trim().toLowerCase();
  const bv = (b ?? '').trim().toLowerCase();
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** delivery date asc (oldest first, missing dates last) → state → postcode.
 *  Returns 0 on a full tie; Array.prototype.sort is stable in every supported
 *  engine, so tied rows keep the server's order. */
export function arrangementQueueCompare(a: ArrangementSortRow, b: ArrangementSortRow): number {
  return (
    cmpBlankLast(arrangementDateOf(a), arrangementDateOf(b)) ||
    cmpBlankLast(a.customer_state, b.customer_state) ||
    cmpBlankLast(a.postcode, b.postcode)
  );
}
