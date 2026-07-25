import { describe, it, expect } from 'vitest';
import {
  validatePing,
  shouldAcceptPing,
  latestPerDriver,
  MIN_PING_GAP_MS,
  PING_ACCEPTED_STATUSES,
} from './tripLocation';

const NOW = Date.parse('2026-07-25T10:00:00.000Z');

describe('validatePing — coordinate ranges', () => {
  it('accepts a valid KL coordinate', () => {
    const r = validatePing({ lat: 3.139, lng: 101.6869, accuracy: 12.5, recorded_at: '2026-07-25T09:59:50.000Z' }, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ping.lat).toBe(3.139);
      expect(r.ping.lng).toBe(101.6869);
      expect(r.ping.accuracyM).toBe(12.5);
      expect(r.ping.recordedAt).toBe('2026-07-25T09:59:50.000Z');
    }
  });

  it('rejects out-of-range lat / lng', () => {
    expect(validatePing({ lat: 91, lng: 0 }, { now: NOW }).ok).toBe(false);
    expect(validatePing({ lat: -91, lng: 0 }, { now: NOW }).ok).toBe(false);
    expect(validatePing({ lat: 0, lng: 181 }, { now: NOW }).ok).toBe(false);
    expect(validatePing({ lat: 0, lng: -181 }, { now: NOW }).ok).toBe(false);
  });

  it('rejects non-numeric / missing coordinates without throwing', () => {
    expect(validatePing({ lat: 'x', lng: 5 }, { now: NOW }).ok).toBe(false);
    expect(validatePing({ lng: 5 }, { now: NOW }).ok).toBe(false);
    expect(validatePing(null, { now: NOW }).ok).toBe(false);
    expect(validatePing('nope', { now: NOW }).ok).toBe(false);
  });

  it('treats accuracy as optional but non-negative when present', () => {
    const noAcc = validatePing({ lat: 1, lng: 2 }, { now: NOW });
    expect(noAcc.ok).toBe(true);
    if (noAcc.ok) expect(noAcc.ping.accuracyM).toBeNull();
    expect(validatePing({ lat: 1, lng: 2, accuracy: -3 }, { now: NOW }).ok).toBe(false);
  });
});

describe('validatePing — recorded_at handling', () => {
  it('defaults a missing recorded_at to now', () => {
    const r = validatePing({ lat: 1, lng: 2 }, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Date.parse(r.ping.recordedAt)).toBe(NOW);
  });

  it('accepts an epoch-millis recorded_at', () => {
    const r = validatePing({ lat: 1, lng: 2, recorded_at: NOW - 5000 }, { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Date.parse(r.ping.recordedAt)).toBe(NOW - 5000);
  });

  it('rejects an unparseable recorded_at', () => {
    expect(validatePing({ lat: 1, lng: 2, recorded_at: 'not-a-date' }, { now: NOW }).ok).toBe(false);
  });

  it('accepts a past device clock (stale is fine) but rejects a far-future one', () => {
    expect(validatePing({ lat: 1, lng: 2, recorded_at: NOW - 3_600_000 }, { now: NOW }).ok).toBe(true);
    expect(validatePing({ lat: 1, lng: 2, recorded_at: NOW + 3_600_000 }, { now: NOW }).ok).toBe(false);
    // Within the allowed skew window is fine.
    expect(validatePing({ lat: 1, lng: 2, recorded_at: NOW + 60_000 }, { now: NOW }).ok).toBe(true);
  });
});

describe('shouldAcceptPing — server-side rate cap', () => {
  it('accepts the first ping (no prior)', () => {
    expect(shouldAcceptPing(null, NOW)).toBe(true);
    expect(shouldAcceptPing(Number.NaN, NOW)).toBe(true);
  });

  it('rejects a ping closer than the minimum gap', () => {
    expect(shouldAcceptPing(NOW, NOW + 5_000)).toBe(false);
    expect(shouldAcceptPing(NOW, NOW + MIN_PING_GAP_MS - 1)).toBe(false);
  });

  it('accepts a ping at or past the minimum gap', () => {
    expect(shouldAcceptPing(NOW, NOW + MIN_PING_GAP_MS)).toBe(true);
    expect(shouldAcceptPing(NOW, NOW + 25_000)).toBe(true);
  });

  it('honours a custom gap', () => {
    expect(shouldAcceptPing(NOW, NOW + 3_000, 2_000)).toBe(true);
    expect(shouldAcceptPing(NOW, NOW + 1_000, 2_000)).toBe(false);
  });
});

describe('PING_ACCEPTED_STATUSES', () => {
  it('only IN_PROGRESS is live', () => {
    expect(PING_ACCEPTED_STATUSES.has('IN_PROGRESS')).toBe(true);
    for (const s of ['PLANNED', 'COMPLETED', 'CANCELLED']) expect(PING_ACCEPTED_STATUSES.has(s)).toBe(false);
  });
});

describe('latestPerDriver — newest row per trip/driver', () => {
  // Input is newest-first (the query orders recorded_at DESC).
  const rows = [
    { trip_id: 'T1', driver_id: 'D1', lat: 3.20, lng: 101.70, accuracy_m: 8, recorded_at: '2026-07-25T10:00:00Z', received_at: '2026-07-25T10:00:01Z' },
    { trip_id: 'T1', driver_id: 'D1', lat: 3.19, lng: 101.69, accuracy_m: 9, recorded_at: '2026-07-25T09:59:30Z', received_at: '2026-07-25T09:59:31Z' },
    { trip_id: 'T2', driver_id: 'D2', lat: 5.41, lng: 100.33, accuracy_m: 15, recorded_at: '2026-07-25T09:58:00Z', received_at: '2026-07-25T09:58:02Z' },
  ];

  it('keeps only the first (newest) row per trip+driver', () => {
    const out = latestPerDriver(rows);
    expect(out).toHaveLength(2);
    const t1 = out.find((o) => o.tripId === 'T1');
    expect(t1?.lat).toBe(3.20);
    expect(t1?.recordedAt).toBe('2026-07-25T10:00:00Z');
    expect(t1?.driverId).toBe('D1');
  });

  it('emits one row per trip for a driver on two trips', () => {
    const out = latestPerDriver([
      { trip_id: 'TA', driver_id: 'D9', lat: 1, lng: 2, recorded_at: 'b', received_at: 'b' },
      { trip_id: 'TB', driver_id: 'D9', lat: 3, lng: 4, recorded_at: 'a', received_at: 'a' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('skips rows with no coordinates or no trip', () => {
    const out = latestPerDriver([
      { trip_id: 'T1', driver_id: 'D1', lat: null, lng: null, recorded_at: 'z', received_at: 'z' },
      { trip_id: '', driver_id: 'D1', lat: 1, lng: 2, recorded_at: 'z', received_at: 'z' },
      { trip_id: 'T3', driver_id: null, lat: 1, lng: 2, recorded_at: 'z', received_at: 'z' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tripId).toBe('T3');
    expect(out[0].driverId).toBeNull();
  });

  it('reads snake_case OR camelCase columns (pg driver camelCases results)', () => {
    const out = latestPerDriver([
      { tripId: 'T1', driverId: 'D1', lat: 3.1, lng: 101.6, accuracyM: 7, recordedAt: 'x', receivedAt: 'y' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].accuracyM).toBe(7);
    expect(out[0].receivedAt).toBe('y');
  });
});
