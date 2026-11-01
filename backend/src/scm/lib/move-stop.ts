// ----------------------------------------------------------------------------
// move-stop — the PURE renumber planner behind the Last Mile "Change lorry"
// action (owner 2026-11-01, phase 3b). Moving a delivery stop from one lorry run
// (trip) to another, or to a new position within its run, must leave BOTH runs
// numbered 1..n with no gaps or collisions. The route applies the plan; the plan
// itself is pure so the renumber rules are testable without a database.
// ----------------------------------------------------------------------------

export type StopLite = { id: string; stop_no: number };

/** One row to write: its (new) stop_no, and its trip_id only when the stop
 *  actually changes trip (the moved stop on a cross-trip move). */
export type StopUpdate = { id: string; stop_no: number; trip_id?: string };

/** Order a stop list by stop_no (stable on ties by id) so a messy or compacted
 *  input renumbers deterministically. */
function ordered(stops: readonly StopLite[]): StopLite[] {
  return stops.slice().sort((a, b) => a.stop_no - b.stop_no || a.id.localeCompare(b.id));
}

/** Renumber an ordered id list to 1..n. Emit a row only when something must
 *  change: the moved stop always (it carries its new trip_id on a cross-trip
 *  move), every other stop only when its number actually shifts. */
function renumber(
  ids: readonly string[],
  priorNoById: Map<string, number>,
  moved: { id: string; tripId: string } | null,
): StopUpdate[] {
  const out: StopUpdate[] = [];
  ids.forEach((id, i) => {
    const no = i + 1;
    if (moved && id === moved.id) out.push({ id, stop_no: no, trip_id: moved.tripId });
    else if (priorNoById.get(id) !== no) out.push({ id, stop_no: no });
  });
  return out;
}

/** Plan an atomic move of `stopId` to 1-based `position` on `targetTripId`,
 *  renumbering the source and target trips to contiguous 1..n.
 *
 *  `sourceStops` is the moved stop's current trip (it MUST contain stopId);
 *  `targetStops` is the destination trip's stops. For a within-trip reorder pass
 *  the same trip id for both and `targetStops: []`. `position` clamps to a valid
 *  slot. Returns the minimal update set; the moved row carries `trip_id` only on
 *  a cross-trip move. */
export function planStopMove(args: {
  stopId: string;
  sourceTripId: string;
  targetTripId: string;
  position: number;
  sourceStops: readonly StopLite[];
  targetStops: readonly StopLite[];
}): StopUpdate[] {
  const { stopId, sourceTripId, targetTripId, position } = args;
  const src = ordered(args.sourceStops);
  if (!src.some((s) => s.id === stopId)) return []; // moved stop not on its trip — nothing to do

  if (sourceTripId === targetTripId) {
    const without = src.filter((s) => s.id !== stopId);
    const pos = Math.max(1, Math.min(position, without.length + 1));
    const ids = [...without.slice(0, pos - 1).map((s) => s.id), stopId, ...without.slice(pos - 1).map((s) => s.id)];
    return renumber(ids, new Map(src.map((s) => [s.id, s.stop_no])), null);
  }

  // Cross-trip: source loses the stop and closes up; target gains it at position.
  const srcWithout = src.filter((s) => s.id !== stopId);
  const srcUpdates = renumber(srcWithout.map((s) => s.id), new Map(src.map((s) => [s.id, s.stop_no])), null);

  const tgt = ordered(args.targetStops.filter((s) => s.id !== stopId));
  const pos = Math.max(1, Math.min(position, tgt.length + 1));
  const tgtIds = [...tgt.slice(0, pos - 1).map((s) => s.id), stopId, ...tgt.slice(pos - 1).map((s) => s.id)];
  const tgtUpdates = renumber(tgtIds, new Map(tgt.map((s) => [s.id, s.stop_no])), { id: stopId, tripId: targetTripId });

  return [...srcUpdates, ...tgtUpdates];
}
