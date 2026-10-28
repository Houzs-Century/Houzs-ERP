import { describe, it, expect } from 'vitest';
import { findCrewLeave, isCrewOnLeave, crewLeaveLabel, type CrewLeaveRow } from './crew-leave';

const row = (o: Partial<CrewLeaveRow>): CrewLeaveRow => ({
  driverId: null, helperId: null, startDate: '2026-08-01', endDate: '2026-08-01', reason: null, ...o,
});

const ROWS: CrewLeaveRow[] = [
  row({ driverId: 'd1', startDate: '2026-08-01', endDate: '2026-08-03', reason: 'MC' }),
  row({ driverId: 'd2', startDate: '2026-08-05', endDate: '2026-08-05' }),
  row({ helperId: 'h1', startDate: '2026-08-02', endDate: '2026-08-04', reason: 'annual leave' }),
];

describe('findCrewLeave — inclusive range, same semantics as the backend', () => {
  it('matches both ends of the range', () => {
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '2026-08-01')).toBe(true);
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '2026-08-03')).toBe(true);
  });

  it('matches a day inside the range', () => {
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '2026-08-02')).toBe(true);
  });

  it('does not match the day before or after', () => {
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '2026-07-31')).toBe(false);
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '2026-08-04')).toBe(false);
  });

  it('matches a single-day range', () => {
    expect(isCrewOnLeave(ROWS, 'driver', 'd2', '2026-08-05')).toBe(true);
    expect(isCrewOnLeave(ROWS, 'driver', 'd2', '2026-08-04')).toBe(false);
  });

  it('never crosses driver and helper id space (mig 0208 XOR)', () => {
    // 'h1' is a HELPER id — asking for a driver with that id must not match.
    expect(isCrewOnLeave(ROWS, 'driver', 'h1', '2026-08-03')).toBe(false);
    expect(isCrewOnLeave(ROWS, 'helper', 'h1', '2026-08-03')).toBe(true);
    expect(isCrewOnLeave(ROWS, 'helper', 'd1', '2026-08-02')).toBe(false);
  });

  it('returns the covering range so the picker can show the dates', () => {
    expect(findCrewLeave(ROWS, 'driver', 'd1', '2026-08-02'))
      .toEqual({ from: '2026-08-01', to: '2026-08-03', reason: 'MC' });
  });

  it('a blank id, blank date or missing rows is never on leave', () => {
    expect(isCrewOnLeave(ROWS, 'driver', '', '2026-08-01')).toBe(false);
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', '')).toBe(false);
    expect(isCrewOnLeave(ROWS, 'driver', 'd1', null)).toBe(false);
    expect(isCrewOnLeave(undefined, 'driver', 'd1', '2026-08-01')).toBe(false);
  });
});

describe('crewLeaveLabel', () => {
  it('carries the reason when one was recorded', () => {
    expect(crewLeaveLabel(findCrewLeave(ROWS, 'driver', 'd1', '2026-08-02'))).toBe('on leave — MC');
  });

  it('falls back to a bare marker when no reason was given', () => {
    expect(crewLeaveLabel(findCrewLeave(ROWS, 'driver', 'd2', '2026-08-05'))).toBe('on leave');
  });

  it('is empty for someone who is not on leave', () => {
    expect(crewLeaveLabel(null)).toBe('');
  });
});
