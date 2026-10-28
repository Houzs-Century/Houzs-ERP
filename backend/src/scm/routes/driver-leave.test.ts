import { describe, it, expect } from 'vitest';
import { isInHouseDriver } from './driver-leave';

describe('isInHouseDriver — the POST guard predicate', () => {
  it('accepts an in-house driver (in_house === true)', () => {
    expect(isInHouseDriver({ in_house: true })).toBe(true);
  });
  it('rejects an external / 3PL driver (in_house === false)', () => {
    expect(isInHouseDriver({ in_house: false })).toBe(false);
  });
  it('rejects a missing/unknown driver (null / undefined row)', () => {
    expect(isInHouseDriver(null)).toBe(false);
    expect(isInHouseDriver(undefined)).toBe(false);
  });
  it('defaults an absent flag to in-house (column is NOT NULL DEFAULT true)', () => {
    expect(isInHouseDriver({})).toBe(true);
  });
});
