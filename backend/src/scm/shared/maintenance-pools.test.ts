import { describe, expect, test } from 'vitest';
import { normalizeInchValue, normalizeConfigInchPools } from './maintenance-pools';

// The quote-doubling mint guard (2026-08-01): a hand-keyed `1""` in a height
// pool is the only in-repo door the doubled-inch-mark class can enter through
// (every height editor is a pool-fed select; no code path appends a quote).
// These tests pin the save-side hygiene: option values in the inch-bearing
// pools collapse doubled marks, everything else in the config is untouched,
// and an already-clean config comes back REFERENCE-identical so untouched
// saves stay byte-identical.

describe('normalizeInchValue', () => {
  test('THE MINT: `1""` collapses to `1"`; runs collapse; trailing whitespace drops', () => {
    expect(normalizeInchValue('1""')).toBe('1"');
    expect(normalizeInchValue('1"""')).toBe('1"');
    expect(normalizeInchValue('1" ')).toBe('1"');
  });

  test('no false merge and no value change: 1" stays 1", 2" stays 2", No Leg untouched', () => {
    expect(normalizeInchValue('1"')).toBe('1"');
    expect(normalizeInchValue('2"')).toBe('2"');
    expect(normalizeInchValue('No Leg')).toBe('No Leg');
    expect(normalizeInchValue('28')).toBe('28');
  });
});

describe('normalizeConfigInchPools', () => {
  test('a doubled hand-keyed option normalizes in every inch pool, keeping each entry shape', () => {
    const config = {
      legHeights: [{ value: '1""', priceSen: 0 }, { value: '2"', priceSen: 500 }],
      sofaLegHeights: [{ value: '6""', priceSen: 0, active: false }],
      gaps: ['16"', '18""'],
      divanHeights: [{ value: '10""', priceSen: 0 }],
      totalHeights: [{ value: '28"', priceSen: 0 }],
      sofaSizes: ['28', '30""'],
      brandings: ['Keep ""me""'], // NOT an inch pool — never walked
      notes: 'he wrote "" on purpose',
    };
    const out = normalizeConfigInchPools(config);
    expect(out.legHeights).toEqual([{ value: '1"', priceSen: 0 }, { value: '2"', priceSen: 500 }]);
    expect(out.sofaLegHeights).toEqual([{ value: '6"', priceSen: 0, active: false }]);
    expect(out.gaps).toEqual(['16"', '18"']);
    expect(out.divanHeights).toEqual([{ value: '10"', priceSen: 0 }]);
    expect(out.totalHeights).toEqual([{ value: '28"', priceSen: 0 }]);
    expect(out.sofaSizes).toEqual(['28', '30"']);
    // Non-inch pools and prose are untouched, verbatim.
    expect(out.brandings).toEqual(['Keep ""me""']);
    expect(out.notes).toBe('he wrote "" on purpose');
  });

  test('an already-clean config returns the SAME reference (untouched saves stay byte-identical)', () => {
    const config = { legHeights: [{ value: '1"', priceSen: 0 }], gaps: ['16"'] };
    expect(normalizeConfigInchPools(config)).toBe(config);
  });

  test('pure: the input object is never mutated', () => {
    const entry = { value: '1""', priceSen: 0 };
    const config = { legHeights: [entry] };
    const out = normalizeConfigInchPools(config);
    expect(entry.value).toBe('1""');
    expect(out).not.toBe(config);
    expect(out.legHeights[0]).toEqual({ value: '1"', priceSen: 0 });
  });

  test('non-object / null / array configs pass through untouched', () => {
    expect(normalizeConfigInchPools(null)).toBe(null);
    const arr = [1, 2];
    expect(normalizeConfigInchPools(arr)).toBe(arr);
  });
});
