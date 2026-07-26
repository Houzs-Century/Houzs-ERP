import { describe, it, expect } from 'vitest';
import { isDriverOnLeave, driversOnLeave, type DriverLeaveRange } from './driver-availability';

const RANGES: DriverLeaveRange[] = [
  { driverId: 'd1', from: '2026-08-01', to: '2026-08-03', reason: 'MC' },
  { driverId: 'd2', from: '2026-08-05', to: '2026-08-05', reason: 'annual' },
];

describe('isDriverOnLeave', () => {
  it('is true on the FIRST and LAST day (inclusive both ends)', () => {
    expect(isDriverOnLeave(RANGES, 'd1', '2026-08-01')).toBe(true);
    expect(isDriverOnLeave(RANGES, 'd1', '2026-08-03')).toBe(true);
  });
  it('is true for a day INSIDE the range', () => {
    expect(isDriverOnLeave(RANGES, 'd1', '2026-08-02')).toBe(true);
  });
  it('is false the day BEFORE and the day AFTER', () => {
    expect(isDriverOnLeave(RANGES, 'd1', '2026-07-31')).toBe(false);
    expect(isDriverOnLeave(RANGES, 'd1', '2026-08-04')).toBe(false);
  });
  it('does not cross drivers', () => {
    expect(isDriverOnLeave(RANGES, 'd2', '2026-08-02')).toBe(false);
    expect(isDriverOnLeave(RANGES, 'd2', '2026-08-05')).toBe(true);
  });
  it('a single-day leave covers exactly that day', () => {
    expect(isDriverOnLeave(RANGES, 'd2', '2026-08-04')).toBe(false);
    expect(isDriverOnLeave(RANGES, 'd2', '2026-08-06')).toBe(false);
  });
});

describe('driversOnLeave', () => {
  it('returns exactly the drivers whose range covers the date', () => {
    expect([...driversOnLeave(RANGES, '2026-08-02')]).toEqual(['d1']);
    expect([...driversOnLeave(RANGES, '2026-08-05')]).toEqual(['d2']);
    expect([...driversOnLeave(RANGES, '2026-08-10')]).toEqual([]);
  });
});
