import { describe, expect, test } from 'vitest';
import {
  foldToAnonymousRuns,
  FORBIDDEN_IDENTITY_KEYS,
  addMinutesToClock,
  estWindowOf,
  DELIVERY_UNLOAD_BUFFER_MIN,
} from './anonymous-runs';
import type { AssignedTrip } from './delivery-zones-queries';

/* The owner's final division (2026-08-08): the Time page sequences (排单) and
 * must not name a lorry or a driver — crew intelligence is Last Mile's. These
 * tests pin the anonymising fold: no identity field survives into the run
 * shape (the opaque vehicleSlotId plumbing excepted, and it is an id the UI
 * never renders), runs number per date, and the computed sequence wins over
 * the packed order when present. */

const stop = (ref: string) => ({
  ref, debtorName: `${ref} customer`, buildingType: 'Landed', address: 'x',
  serviceMinutes: 90, earliestTime: null, latestTime: null,
});

const trip = (over: Partial<AssignedTrip>): AssignedTrip => ({
  key: 'k1', date: '2026-08-10', group: 'KLANG_VALLEY',
  lorryId: 'lorry-uuid-a', plate: 'VNB9058',
  driverId: 'drv-1', driverName: 'Ali', helperId: 'hlp-1', helperName: 'Bob',
  sets: 3, revenueSen: 500_00, ceilingSets: 10, ceilingRevenueSen: null,
  overCeiling: false, departTime: '09:00',
  stops: [stop('SO-1'), stop('SO-2')], sequence: null,
  routeReason: null, ungeocoded: [],
  ...over,
});

describe('foldToAnonymousRuns — no lorry identity on the Time page', () => {
  test('THE pin: no run and no stop carries any identity key; the only vehicle reference is the opaque slot id', () => {
    const runs = foldToAnonymousRuns([
      trip({}),
      trip({ key: 'k2', group: 'JOHOR', lorryId: 'lorry-uuid-b', plate: 'WXY1111', driverName: 'Chan' }),
    ]);
    expect(runs.length).toBe(2);
    for (const run of runs) {
      for (const key of FORBIDDEN_IDENTITY_KEYS) {
        expect(run).not.toHaveProperty(key);
        for (const s of run.stops) expect(s).not.toHaveProperty(key);
      }
      /* The plumbing slot survives, as an id only — and never a plate string. */
      expect(run.vehicleSlotId).toMatch(/^lorry-uuid-/);
      expect(JSON.stringify({ ...run, vehicleSlotId: '' })).not.toContain('VNB9058');
      expect(JSON.stringify({ ...run, vehicleSlotId: '' })).not.toContain('Ali');
    }
  });

  test('runs number 1..n WITHIN each date (zone A->Z), restarting per date', () => {
    const runs = foldToAnonymousRuns([
      trip({ key: 'b', group: 'KLANG_VALLEY' }),
      trip({ key: 'a', group: 'JOHOR' }),
      trip({ key: 'c', date: '2026-08-11' }),
    ]);
    expect(runs.map((r) => `${r.date} #${r.runNo} ${r.group}`)).toEqual([
      '2026-08-10 #1 JOHOR',
      '2026-08-10 #2 KLANG_VALLEY',
      '2026-08-11 #1 KLANG_VALLEY',
    ]);
  });

  test('the computed sequence orders the stops when present; the packed order otherwise', () => {
    const sequenced = foldToAnonymousRuns([trip({
      sequence: {
        departTime: '09:00',
        sequence: [
          { ref: 'SO-2', order: 1, travelMinutes: 10, distanceMetres: 5000, arrivalTime: '09:10', waitMinutes: 0, startServiceTime: '09:10', finishTime: '10:40', serviceMinutes: 90, earliestTime: null, latestTime: null, windowViolated: false, etaOffsetS: 600, legDistanceM: 5000, legDurationS: 600 },
          { ref: 'SO-1', order: 2, travelMinutes: 12, distanceMetres: 6000, arrivalTime: '10:52', waitMinutes: 0, startServiceTime: '10:52', finishTime: '12:22', serviceMinutes: 90, earliestTime: null, latestTime: '12:00', windowViolated: true, etaOffsetS: 6720, legDistanceM: 6000, legDurationS: 720 },
        ],
        totalTravelMinutes: 22, totalDistanceMetres: 11000, returnTime: '13:00', windowViolations: 1,
      },
    })])[0];
    expect(sequenced.stops.map((s) => s.ref)).toEqual(['SO-2', 'SO-1']);
    expect(sequenced.stops[0].arrivalTime).toBe('09:10');
    expect(sequenced.stops[1].windowViolated).toBe(true);
    expect(sequenced.windowViolations).toBe(1);
    expect(sequenced.returnTime).toBe('13:00');

    const packed = foldToAnonymousRuns([trip({})])[0];
    expect(packed.stops.map((s) => `${s.order}:${s.ref}`)).toEqual(['1:SO-1', '2:SO-2']);
    expect(packed.stops[0].arrivalTime).toBeNull();
  });

  test('capacity facts survive anonymisation — over-capacity is real, just nameless', () => {
    const run = foldToAnonymousRuns([trip({ overCeiling: true, sets: 12 })])[0];
    expect(run.overCapacity).toBe(true);
    expect(run.sets).toBe(12);
  });
});

describe('the estimated delivery window — Google ETA + installation + unload buffer (owner 2026-08-08)', () => {
  test('arrival–(finish + buffer): the 几点到几点 range', () => {
    /* finishTime already contains the installation time (residence-rule service
       minutes folded into the engine's clock); the buffer pads the unload. */
    expect(estWindowOf({ arrivalTime: '09:40', finishTime: '10:10' })).toBe(`09:40–${addMinutesToClock('10:10', DELIVERY_UNLOAD_BUFFER_MIN)}`);
    expect(estWindowOf({ arrivalTime: '09:40', finishTime: '10:10' }, 15)).toBe('09:40–10:25');
  });

  test('no computed route -> null, never a fabricated clock', () => {
    expect(estWindowOf({ arrivalTime: null, finishTime: null })).toBeNull();
    expect(estWindowOf({ arrivalTime: '09:40', finishTime: null })).toBeNull();
  });

  test('clock arithmetic wraps the day and rejects garbage', () => {
    expect(addMinutesToClock('23:50', 20)).toBe('00:10');
    expect(addMinutesToClock('09:05', 0)).toBe('09:05');
    expect(addMinutesToClock('not a clock', 15)).toBeNull();
    expect(addMinutesToClock(null, 15)).toBeNull();
  });
});
