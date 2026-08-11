// ----------------------------------------------------------------------------
// arrangement-sort — the arrangement queues' default ordering.
//
// Owner, 2026-08-08 (v3 — superseding the same-day v2): the beautiful default
// is NEW date first, OLD date as the late tiebreak, doc number last — EXCEPT on
// the pending-date side, where the customer's ORIGINAL date outranks geography:
//
//   1. the ARRANGED ("new") delivery date — amended_delivery_date, the date WE
//      set — OLDEST first; rows without one sink BELOW every row that has one,
//   1b. when BOTH rows lack a new date (the pending-date side): the ORIGINAL
//      customer_delivery_date, oldest first (blanks last) — the oldest-promised
//      customer waits at the top, BEFORE any geography grouping,
//   2. then customer state, A→Z (blanks last),
//   3. then postcode, A→Z (blanks last),
//   4. then run time (ETA offset, stop sequence) on the live trip,
//   5. then the ORIGINAL ("old" / estimated) customer_delivery_date, oldest
//      first (blanks last) — a no-op on the pending side (1b already decided),
//   6. then the document number, so full ties land in a stable, readable run.
//
// Applies to BOTH arrangement queues (Date Arrangement queue, Time Arrangement
// inbox), BOTH sides each. On the Pending-Date side the amended date is null by
// definition, so the queue orders by the customer's original date first, then
// state → postcode — "还没排的，谁答应得最早谁先排", geography second. When
// either row HAS a new date the established order stands unchanged.
//
// This is a DEFAULT, not a lock: it applies only while no column sort is
// active. A header the operator clicks overrides as always, and cycling the
// header back to "off" returns here rather than to raw fetch order.
//
// Pure and shared so the two pages can never drift apart; pinned by
// arrangement-sort.test.ts.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from './delivery-planning-queries';

/** The comparator reads only these fields, so tests (and any future caller)
 *  can build rows without the full PlanningOrder shape. */
export type ArrangementSortRow = Pick<
  PlanningOrder,
  | 'amended_delivery_date'
  | 'customer_delivery_date'
  | 'customer_state'
  | 'postcode'
> & {
  /* Nullable here (unlike PlanningOrder's non-null so_doc_no): a DP row keys
     the final tiebreak on dp_no instead, and the comparator's `?? dp_no`
     fallback needs the null to be expressible. A full PlanningOrder row still
     satisfies this shape (string is assignable). */
  so_doc_no?: string | null;
  dp_no?: string | null;
  trip_eta_offset_s?: number | null;
  trip_stop_no?: number | null;
};

/** Truncate a date-ish value to its calendar day (YYYY-MM-DD); null = none. */
function dayOf(d: string | null | undefined): string | null {
  if (d == null) return null;
  const day = String(d).slice(0, 10);
  return day || null;
}

/** The ARRANGED ("new") delivery date — the date this pipeline wrote. */
export function arrangementDateOf(o: ArrangementSortRow): string | null {
  return dayOf(o.amended_delivery_date);
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

/* Numeric asc, null LAST — the TIME key (owner 2026-08-08: within the same
   date/state/postcode group the Time queues also order by run time). ETA
   offset first (the clock the driver sees), stop sequence as its tiebreak;
   rows not on a trip carry null and simply tie through. */
function cmpNumBlankLast(a: number | null | undefined, b: number | null | undefined): number {
  const av = typeof a === 'number' ? a : null;
  const bv = typeof b === 'number' ? b : null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av - bv;
}

/** new date → [both new-dateless: old date] → state → postcode → run time →
 *  old date → doc no (asc, blanks last). */
export function arrangementQueueCompare(a: ArrangementSortRow, b: ArrangementSortRow): number {
  const newA = arrangementDateOf(a);
  const newB = arrangementDateOf(b);
  const byNew = cmpBlankLast(newA, newB);
  if (byNew !== 0) return byNew;
  /* Pending-date side (owner 2026-08-08 v3): when NEITHER row has an arranged
     date, the customer's ORIGINAL promised date outranks geography — oldest
     promise first. When either row has a new date the established order stands
     (equal non-null new dates group by state → postcode as before). */
  if (newA == null && newB == null) {
    const byOld = cmpBlankLast(dayOf(a.customer_delivery_date), dayOf(b.customer_delivery_date));
    if (byOld !== 0) return byOld;
  }
  return (
    cmpBlankLast(a.customer_state, b.customer_state) ||
    cmpBlankLast(a.postcode, b.postcode) ||
    cmpNumBlankLast(a.trip_eta_offset_s, b.trip_eta_offset_s) ||
    cmpNumBlankLast(a.trip_stop_no, b.trip_stop_no) ||
    cmpBlankLast(dayOf(a.customer_delivery_date), dayOf(b.customer_delivery_date)) ||
    cmpBlankLast(a.so_doc_no ?? a.dp_no, b.so_doc_no ?? b.dp_no)
  );
}
