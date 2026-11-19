/* ── Stale leg progress on a re-schedule ──────────────────────────────────────
   When a Service-Case leg is re-scheduled onto a DIFFERENT trip, any crew
   progress stamped against the PREVIOUS trip — On-the-way / Arrived / Delivered
   plus its POD photos — is stale: the run it belonged to was abandoned. But the
   Last Mile / fleet-day board keys `scm.job_progress` by JOB
   (source_type:source_id:leg), not by trip, and reads `completed_at` for its
   "Delivered" badge. So a leftover completion kept a leg showing Delivered
   through every re-schedule and re-crew, with no way to clear it from the UI —
   case ASSR/2610-048: a pickup marked done by mistake on 2026-11-03 stayed
   "Delivered" across three re-books onto new lorries.

   scheduleAssrOntoTrip already DROPS the leg's trip_stop on every other trip
   (so lorry capacity isn't double-counted); its progress must go the same way.
   This returns the RESET the caller applies to job_progress, filtered to rows
   NOT on the new trip (`excludeTripId`) — the SAME scoping as the stale
   trip_stop delete — so the current run's own, real progress is never touched.
   It is a pure function (no DB, no Worker) so the "clear everything, keep only
   the current trip, re-point at it" contract is assertable in a unit test. */

export type StaleLegProgressReset = {
  /** The job whose progress is cleared: one leg of one source document. */
  match: { source_type: string; source_id: string; leg: string };
  /** Only progress recorded on a trip OTHER than this one is stale — the caller
   *  filters `trip_id != excludeTripId`, so the new run's own progress stays. */
  excludeTripId: string;
  /** Every crew / POD stamp cleared, and the row re-pointed at the new trip so
   *  the next On-the-way lands on the right run. `updated_at` is stamped by the
   *  caller (it owns the clock). */
  set: {
    departed_at: null; departed_by: null;
    arrived_at: null; arrived_by: null;
    completed_at: null; completed_by: null;
    pod_photo_keys: string[]; pod_notes: null;
    pod_lat: null; pod_lng: null; pod_accuracy_m: null; pod_located_at: null;
    trip_id: string;
  };
};

export function staleLegProgressReset(
  sourceType: 'assr' | 'dp',
  sourceId: number | string,
  leg: string,
  newTripId: string,
): StaleLegProgressReset {
  return {
    match: { source_type: sourceType, source_id: String(sourceId), leg },
    excludeTripId: newTripId,
    set: {
      departed_at: null, departed_by: null,
      arrived_at: null, arrived_by: null,
      completed_at: null, completed_by: null,
      pod_photo_keys: [], pod_notes: null,
      pod_lat: null, pod_lng: null, pod_accuracy_m: null, pod_located_at: null,
      trip_id: newTripId,
    },
  };
}
