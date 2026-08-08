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

/** The "Propose crew" candidate set (owner's final division 2026-08-08: Last
 *  Mile owns the intelligent driver + lorry assignment). Crew is proposed ONLY
 *  for the picked day's already-sequenced runs — the TIME_ARRANGED side of the
 *  day board: an SO on a live trip that date, not yet delivered. A delivered
 *  drop needs no crew; another day's run belongs to its own day; anything not
 *  on a run yet is still the Time page's business (排单 first). */
export function proposeCrewDocNos(
  orders: Array<LastMileRow & Pick<PlanningOrder, 'so_doc_no'>>,
  date: string,
): string[] {
  return orders
    .filter((o) => lastMileSideOf(o, date) === 'TIME_ARRANGED')
    .map((o) => o.so_doc_no);
}

/* ── Matching the crew intelligence back onto the day's EXISTING runs.
   Owner: "我只需要帮它标上去是什么罗里、什么 Driver、什么 Helper" — Last Mile
   LABELS crew onto the trips the Time page staged; it re-sequences nothing.
   The A2/A3 engine answers in its own packed runs, so its per-run crew picks
   are re-attached to the real trips by stop overlap: each engine run votes for
   the existing trip that carries the MOST of its orders (ties break to the
   first-seen trip; an engine run whose orders sit on no existing day-trip
   attaches to NOTHING — crew is never suggested for a run that does not
   exist). One suggestion per trip; a second engine run mapping to the same
   trip is ignored (first wins — deterministic, and the collision is a re-pack
   divergence the dispatcher resolves by hand if it ever matters). */

export type CrewSuggestion = {
  lorryId: string | null;
  driverId: string | null;
  driverName: string | null;
  helperId: string | null;
  helperName: string | null;
};

type EngineRun = {
  lorryId: string | null;
  driverId: string | null;
  driverName: string | null;
  helperId: string | null;
  helperName: string | null;
  stops: Array<{ ref: string }>;
};

export function matchCrewSuggestions(
  engineRuns: EngineRun[],
  tripIdByDocNo: Map<string, string>,
): Map<string, CrewSuggestion> {
  const out = new Map<string, CrewSuggestion>();
  for (const run of engineRuns) {
    const votes = new Map<string, number>();
    const order: string[] = [];
    for (const s of run.stops) {
      const tripId = tripIdByDocNo.get(s.ref);
      if (!tripId) continue;
      if (!votes.has(tripId)) order.push(tripId);
      votes.set(tripId, (votes.get(tripId) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const tripId of order) {
      if (best == null || (votes.get(tripId) ?? 0) > (votes.get(best) ?? 0)) best = tripId;
    }
    if (best == null || out.has(best)) continue;
    out.set(best, {
      lorryId: run.lorryId,
      driverId: run.driverId,
      driverName: run.driverName,
      helperId: run.helperId,
      helperName: run.helperName,
    });
  }
  return out;
}
