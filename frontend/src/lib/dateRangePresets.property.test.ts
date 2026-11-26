import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addDays,
  dayDiff,
  daysInRange,
  isIsoDay,
  monthEnd,
  monthStart,
  presetOf,
  presetRange,
  type RangePresetKey,
} from './dateRangePresets';

const isoDay = fc
  .date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2100-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));

const boundedKeys: readonly RangePresetKey[] = [
  'today', 'last7', 'thisMonth', 'lastMonth', 'last3Months', 'last12Months', 'thisYear',
  'thisQuarter', 'lastQuarter', 'yearToDate', 'lastYear', 'nextMonth', 'nextQuarter',
  'next12Months', 'wholeMonth', 'wholeQuarter', 'wholeYear',
];

describe('date range properties', () => {
  it('addDays by n then by -n is the identity', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: -20_000, max: 20_000 }), (d, n) => {
        expect(addDays(addDays(d, n), -n)).toBe(d);
      }),
    );
  });

  it('dayDiff measures exactly what addDays moved', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: -20_000, max: 20_000 }), (d, n) => {
        expect(dayDiff(d, addDays(d, n))).toBe(n);
      }),
    );
  });

  it('every bounded preset is a real, non-empty range of real days', () => {
    fc.assert(
      fc.property(isoDay, fc.constantFrom(...boundedKeys), (today, key) => {
        const r = presetRange(key, today);
        expect(isIsoDay(r.from)).toBe(true);
        expect(isIsoDay(r.to)).toBe(true);
        expect(daysInRange(r.from, r.to)).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  it('presetOf recognises the range a preset produced', () => {
    fc.assert(
      fc.property(isoDay, fc.constantFrom(...boundedKeys, 'all' as const), (today, key) => {
        const r = presetRange(key, today);
        const found = presetOf(r, [key], today);
        expect(found).toBe(key);
      }),
    );
  });

  it('monthStart is day 1 and monthEnd is the day before the next monthStart', () => {
    fc.assert(
      fc.property(isoDay, fc.integer({ min: -24, max: 24 }), (d, n) => {
        expect(monthStart(d, n).slice(8)).toBe('01');
        expect(addDays(monthEnd(d, n), 1)).toBe(monthStart(d, n + 1));
        expect(monthStart(monthStart(d, n))).toBe(monthStart(d, n));
      }),
    );
  });
});
