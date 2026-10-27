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

// ── The LIST side (owner 2026-10-21): the dispatcher wanted to pick tomorrow and
//    SEE tomorrow's orders here, before any trip exists. The day MAP already
//    showed them (its geo read keys on the delivery date); the left board did
//    not, because it keyed on the live trip only — so "20 on the map, 0 in the
//    list". The list gains a THIRD side, TO_ARRANGE: an SO due this day that is
//    not on a lorry run yet. lastMileSideOf above stays trip-only on purpose —
//    map focus, crew proposal and stop-status must still see trip rows ONLY (a
//    TO_ARRANGE row has no trip / stop to colour or crew). The list is the one
//    place the two merge (lastMileListSideOf).
export type LastMileListSide = LastMileSide | 'TO_ARRANGE';

/* The list sides in rail order, each with its chip label. ONE home for the
   vocabulary: FleetDay's chips, its per-side counts and its labels all derive
   from this array, so a fourth side is added here and nowhere else. */
export const LAST_MILE_LIST_SIDES: ReadonlyArray<{ side: LastMileListSide; label: string }> = [
  { side: 'TO_ARRANGE', label: 'To arrange' },
  { side: 'TIME_ARRANGED', label: 'Time arranged' },
  { side: 'DELIVERED', label: 'Delivered' },
];

export const LAST_MILE_LIST_SIDE_LABEL = Object.fromEntries(
  LAST_MILE_LIST_SIDES.map((s) => [s.side, s.label]),
) as Record<LastMileListSide, string>;

type ToArrangeRow = Pick<
  PlanningOrder,
  'row_type' | 'trip_date' | 'delivery_state' | 'effective_delivery_date' | 'customer_delivery_date' | 'processing_date'
>;

/* The day a not-yet-arranged order is DUE — the same effective date the board
   and the mobile run-sheet bucket on (amended ?? original, then processing). */
const toArrangeDateOf = (o: ToArrangeRow): string | null =>
  o.effective_delivery_date || o.customer_delivery_date || o.processing_date || null;

/** An SO due this day that is NOT on a lorry run yet — the list's TO_ARRANGE
 *  side. SO rows only; excluded once a live trip carries it (its trip's day owns
 *  it then, as lastMileSideOf decides) or once it is delivered. */
export function isToArrangeRow(o: ToArrangeRow, date: string): boolean {
  if (o.row_type !== 'so') return false;
  if (o.trip_date != null) return false;
  if (o.delivery_state === 'DELIVERED') return false;
  const d = toArrangeDateOf(o);
  return d != null && String(d).slice(0, 10) === date;
}

/** The list's side for a row: a live-trip row keeps its trip side (TIME_ARRANGED
 *  / DELIVERED); otherwise a due-this-day SO with no trip is TO_ARRANGE; else it
 *  is off this day's list. */
export function lastMileListSideOf(o: LastMileRow & ToArrangeRow, date: string): LastMileListSide | null {
  const trip = lastMileSideOf(o, date);
  if (trip) return trip;
  return isToArrangeRow(o, date) ? 'TO_ARRANGE' : null;
}

/* East Malaysia (Sabah / Sarawak / Labuan) and Singapore ship by their OWN
   channel — consolidated out of KL and sent by freight, not on the local
   last-mile lorry run — so they are kept OFF the Last Mile board (owner
   2026-10-25). They still appear on the Delivery Planning board and in their own
   EM / SG modules; this exclusion is Last-Mile-only, applied by FleetDay (the
   admin board + its day map) and the mobile driver run-sheet, never in the
   shared backend feed.

   'EM' is the config region bucket for East Malaysia. Singapore folds into
   'Southern', so it is caught by COUNTRY, not region. The state check is a
   belt-and-braces fallback for East Malaysia in case the region config is
   renamed. Takes the three geography fields by generic name so the SAME rule
   serves both a board row (region / customer_state / customer_country) and a
   day-map point (region / state / country). */
export function isEastMalaysiaOrSingaporeStop(loc: {
  region?: string | null;
  state?: string | null;
  country?: string | null;
}): boolean {
  if ((loc.country ?? '').trim().toLowerCase() === 'singapore') return true;
  if ((loc.region ?? '') === 'EM') return true;
  const st = (loc.state ?? '').trim().toLowerCase();
  return st === 'sabah' || st === 'sarawak' || st === 'labuan';
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
