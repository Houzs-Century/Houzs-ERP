// ----------------------------------------------------------------------------
// last-mile — how the Last Mile Delivery page (FleetDay.tsx) derives its board
// rows from the shared delivery-planning feed (owner pipeline 2026-08-07/08:
// Planning -> Date -> Time -> Last Mile; "time-arranged orders flow in
// automatically").
//
// The page owns ONE day. Its rows are simply the SO rows whose live trip sits
// on that day — the server already stamps trip_id / trip_no / trip_date on
// every SO row (CANCELLED trips excluded, backend lib/arrangement-stage.ts's
// sibling read), so nothing is re-derived here. Two sides:
//
//   TIME_ARRANGED — the server-stamped stage: on a live trip, still to run.
//   DELIVERED     — delivery_state DELIVERED with a trip that day: the day's
//                   completed drops. They stay visible as done rather than
//                   vanishing mid-shift (the stage stamp is null once an order
//                   leaves Pending Schedule, so the state is the honest signal).
//
// Anything else on a trip that day (e.g. a manual override parked elsewhere)
// folds into the TO-RUN side — a row on today's lorry must never be invisible
// on today's execution page. Pinned by last-mile.test.ts.
// ----------------------------------------------------------------------------
import type { PlanningOrder } from './delivery-planning-queries';

export type LastMileSide = 'TIME_ARRANGED' | 'DELIVERED';

export const LAST_MILE_SIDE_LABEL: Record<LastMileSide, string> = {
  TIME_ARRANGED: 'Time arranged',
  DELIVERED: 'Delivered',
};

type LastMileRow = Pick<PlanningOrder, 'row_type' | 'trip_date' | 'delivery_state' | 'arrangement_stage'>;

/** Does this row belong to the picked day's execution board at all?
 *  SO rows only (ASSR / DP / project scheduling lives on their own documents),
 *  keyed on the server-stamped live-trip date. */
export function isLastMileRow(o: LastMileRow, date: string): boolean {
  return o.row_type === 'so' && o.trip_date != null && String(o.trip_date).slice(0, 10) === date;
}

/** Which side of the execution split a day-row sits on. null for rows that are
 *  not on the picked day at all. */
export function lastMileSideOf(o: LastMileRow, date: string): LastMileSide | null {
  if (!isLastMileRow(o, date)) return null;
  return o.delivery_state === 'DELIVERED' ? 'DELIVERED' : 'TIME_ARRANGED';
}
