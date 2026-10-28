/* ── The delivery ARRANGEMENT pipeline — derived sub-states, no new columns ────
 *
 * Owner's rule (2026-08-07): every order in the board's Pending Schedule state
 * means "needs a delivery DATE arranged". All of them flow into the Delivery
 * Date Arrangement page ("它的 Outlook、UI、Frontend、Backend、Database，以及所有的
 * column 等等，该有的资料全部都要进到去" — full data fidelity, never a stripped
 * subset). Once a date is CONFIRMED there, the order flows automatically into
 * Delivery Time Arrangement (the Trips page) as work to do; once it is assigned
 * onto a trip it is arranged. Two visible splits, one per side:
 *
 *   Date side:  Pending Date Arrangement  vs  Date arranged
 *   Time side:  Pending Time Arrangement  vs  Time arranged
 *
 * DERIVED, NEVER STORED. The three underlying facts already live in the data
 * model, so the pipeline stage is computed per request exactly like
 * derivePlanningState — there is no arrangement column anywhere:
 *
 *   in the pipeline  = delivery_state === 'PENDING_SCHEDULE'
 *                      (the shared derivePlanningState, untouched)
 *   dateConfirmed    = the order carries a confirmed/amended delivery date —
 *                      mfg_sales_orders.amended_delivery_date IS NOT NULL for an
 *                      SO row (written ONLY through the established schedule
 *                      path, PATCH /delivery-planning/so/:id/schedule; the
 *                      customer's original date is never overwritten), or
 *                      dp_orders.requested_date for a manual DP job.
 *   onActiveTrip     = the order sits on a lorry-day: a DELIVERY trip_stop keyed
 *                      on one of its DO uuids (trip_stops.do_id) whose trip is
 *                      not CANCELLED. (A manual DP job counts its own
 *                      dp_orders.trip_id instead.)
 *
 * The three stages are MUTUALLY EXCLUSIVE and ordered — a stop on a live trip
 * dominates (an order somebody put on a lorry without first writing an amended
 * date is arranged, not stuck):
 *
 *   PENDING_DATE   — in Pending Schedule, no confirmed date, not on a trip.
 *   PENDING_TIME   — date confirmed, not yet on a trip. (== "Date arranged"
 *                    on the date side: the Date page is done with it, the Time
 *                    page's inbox now owns it.)
 *   TIME_ARRANGED  — on a live (non-CANCELLED) trip.
 *
 * Outside Pending Schedule the stage is null: a not-ready order has nothing to
 * arrange yet, and a delivered one has left the pipeline. ASSR legs and PMS
 * project windows land as PENDING_DELIVERY on the board, so they carry null by
 * construction — their scheduling lives on their own documents.
 *
 * KNOWN, DOCUMENTED GAP (BUG-HISTORY 2026-07-22): a type:'so' schedule for an SO
 * with no DO writes NO trip_stop at all (mfg_sales_orders has a TEXT PK and no
 * uuid for trip_stops.so_id), so such an order cannot read as TIME_ARRANGED —
 * it stays PENDING_TIME even though a trip row exists. That is honest: with no
 * stop, no lorry's run sheet carries the job. Cut the DO first (the normal
 * flow) and the stop — and the stage — follow.
 *
 * Pure — no I/O. The board endpoint (delivery-planning.ts GET /) resolves the
 * two booleans and stamps `arrangement_stage` on every row; both frontends read
 * the stamped field and never re-derive. */

export type ArrangementStage = 'PENDING_DATE' | 'PENDING_TIME' | 'TIME_ARRANGED';

/** The date-side view of a stage: has this order's delivery DATE been arranged? */
export type DateArrangement = 'PENDING_DATE' | 'DATE_ARRANGED';
/** The time-side view of a stage: only defined once the date side is done. */
export type TimeArrangement = 'PENDING_TIME' | 'TIME_ARRANGED';

export function deriveArrangementStage(input: {
  /** The row's derived (or overridden) 4-state — derivePlanningState's output. */
  deliveryState: string | null | undefined;
  /** A confirmed delivery date exists (amended_delivery_date / requested_date). */
  dateConfirmed: boolean;
  /** A DELIVERY stop on a non-CANCELLED trip references this order. */
  onActiveTrip: boolean;
}): ArrangementStage | null {
  if (input.deliveryState !== 'PENDING_SCHEDULE') return null;
  if (input.onActiveTrip) return 'TIME_ARRANGED';
  if (input.dateConfirmed) return 'PENDING_TIME';
  return 'PENDING_DATE';
}

/* The two side-views, kept beside the stage rule so a tab can never disagree
   with the stage it was computed from. PENDING_TIME *is* "Date arranged" — the
   same order seen from the other side of the hand-off. */
export function dateSideOf(stage: ArrangementStage | null): DateArrangement | null {
  if (stage == null) return null;
  return stage === 'PENDING_DATE' ? 'PENDING_DATE' : 'DATE_ARRANGED';
}

export function timeSideOf(stage: ArrangementStage | null): TimeArrangement | null {
  if (stage === 'PENDING_TIME') return 'PENDING_TIME';
  if (stage === 'TIME_ARRANGED') return 'TIME_ARRANGED';
  return null; // PENDING_DATE / out of pipeline — not the Time page's yet
}
