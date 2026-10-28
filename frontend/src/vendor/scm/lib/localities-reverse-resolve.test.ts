// ----------------------------------------------------------------------------
// Reverse address-resolution helpers.
//
// The SO / mobile SO forms let the operator start from a Postcode or a City and
// have the State (and, via the state→warehouse mapping, the Sales Location) fill
// itself in. These tests pin the resolver contract the wiring depends on:
//   - a postcode resolves to its unique {state, city}
//   - a city resolves to its state ONLY when unambiguous
//   - an ambiguous city yields NO guess (null)
//   - resolving never mutates its input (so a postcode can't wipe itself)
// ----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import {
  resolvePostcode,
  resolveCityState,
  allCities,
  allPostcodes,
  type LocalityRow,
} from './localities-queries';

const row = (postcode: string, city: string, state: string): LocalityRow => ({
  postcode, city, state, stateCode: '', country: 'Malaysia',
});

// A small MY fixture. "Taman Melati" deliberately sits under TWO states to
// exercise the ambiguous-city path; 43300 is a real single-state Selangor code.
const ROWS: LocalityRow[] = [
  row('43300', 'Seri Kembangan', 'Selangor'),
  row('47810', 'Petaling Jaya', 'Selangor'),
  row('50000', 'Kuala Lumpur', 'Wilayah Persekutuan Kuala Lumpur'),
  row('10000', 'George Town', 'Pulau Pinang'),
  row('81100', 'Taman Melati', 'Johor'),        // ambiguous city ↓
  row('53100', 'Taman Melati', 'Wilayah Persekutuan Kuala Lumpur'),
];

describe('resolvePostcode', () => {
  it('maps a postcode to its unique {state, city}', () => {
    expect(resolvePostcode(ROWS, '43300')).toEqual({ state: 'Selangor', city: 'Seri Kembangan' });
    expect(resolvePostcode(ROWS, '10000')).toEqual({ state: 'Pulau Pinang', city: 'George Town' });
  });

  it('trims whitespace and matches exact string codes', () => {
    expect(resolvePostcode(ROWS, '  50000 ')).toEqual({
      state: 'Wilayah Persekutuan Kuala Lumpur', city: 'Kuala Lumpur',
    });
  });

  it('returns null for an unknown / empty postcode (never guesses)', () => {
    expect(resolvePostcode(ROWS, '99999')).toBeNull();
    expect(resolvePostcode(ROWS, '')).toBeNull();
    expect(resolvePostcode([], '43300')).toBeNull();
  });

  it('does not mutate the input rows (postcode set cannot wipe itself)', () => {
    const snapshot = JSON.stringify(ROWS);
    resolvePostcode(ROWS, '43300');
    expect(JSON.stringify(ROWS)).toBe(snapshot);
  });
});

describe('resolveCityState', () => {
  it('resolves an unambiguous city to its state (case-insensitive)', () => {
    expect(resolveCityState(ROWS, 'Petaling Jaya')).toBe('Selangor');
    expect(resolveCityState(ROWS, 'george town')).toBe('Pulau Pinang');
  });

  it('returns null for a city shared by more than one state (no wrong guess)', () => {
    expect(resolveCityState(ROWS, 'Taman Melati')).toBeNull();
  });

  it('returns null for an unknown / empty city', () => {
    expect(resolveCityState(ROWS, 'Nowhere')).toBeNull();
    expect(resolveCityState(ROWS, '')).toBeNull();
  });
});

describe('all-state option pools', () => {
  it('lists every distinct city and postcode across all states, sorted', () => {
    expect(allCities(ROWS)).toContain('George Town');
    expect(allCities(ROWS)).toContain('Taman Melati');
    expect(allCities(ROWS)).toEqual([...allCities(ROWS)].sort());
    expect(allPostcodes(ROWS)).toContain('43300');
    expect(allPostcodes(ROWS)).toEqual([...allPostcodes(ROWS)].sort());
  });
});
