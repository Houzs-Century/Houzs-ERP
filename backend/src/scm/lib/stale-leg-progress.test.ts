import { describe, it, expect } from 'vitest';
import { staleLegProgressReset } from './stale-leg-progress';

/* Regression: a Service-Case pickup marked done by mistake (job_progress.completed_at)
   stayed "Delivered" on the Last Mile board through every re-schedule onto a new
   lorry, because the board keys progress by job, not by trip, and nothing cleared
   the old run's completion (case ASSR/2610-048). scheduleAssrOntoTrip now resets
   the leg's progress on the trips it moved OFF; this locks the reset's contract. */
describe('staleLegProgressReset', () => {
  it('clears every crew / POD stamp and re-points the leg at the new trip', () => {
    const r = staleLegProgressReset('assr', 1611, 'customer_pickup', 'NEW-TRIP');
    expect(r.match).toEqual({ source_type: 'assr', source_id: '1611', leg: 'customer_pickup' });
    expect(r.set.departed_at).toBeNull();
    expect(r.set.departed_by).toBeNull();
    expect(r.set.arrived_at).toBeNull();
    expect(r.set.arrived_by).toBeNull();
    expect(r.set.completed_at).toBeNull();
    expect(r.set.completed_by).toBeNull();
    expect(r.set.pod_photo_keys).toEqual([]);
    expect(r.set.pod_notes).toBeNull();
    expect(r.set.pod_lat).toBeNull();
    expect(r.set.pod_lng).toBeNull();
    expect(r.set.pod_accuracy_m).toBeNull();
    expect(r.set.pod_located_at).toBeNull();
    expect(r.set.trip_id).toBe('NEW-TRIP');
  });

  it('coerces a numeric case id to the text source_id job_progress stores', () => {
    expect(staleLegProgressReset('assr', 1611, 'customer_pickup', 't').match.source_id).toBe('1611');
  });

  it('targets only progress on a trip OTHER than the new one (never the current run)', () => {
    // The caller filters `trip_id != excludeTripId`; a re-press of the SAME trip
    // (excludeTripId == that trip) matches nothing, so a real completion survives.
    expect(staleLegProgressReset('assr', 42, 'delivery', 'T2').excludeTripId).toBe('T2');
  });
});
