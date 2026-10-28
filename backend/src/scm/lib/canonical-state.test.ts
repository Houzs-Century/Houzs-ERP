import { describe, expect, it } from 'vitest';
import { canonicalizeMyState, isCanonicalMyState, CANONICAL_MY_STATES } from './canonical-state';

describe('canonicalizeMyState', () => {
  it('returns the input unchanged for null / undefined / empty', () => {
    expect(canonicalizeMyState(null)).toBeNull();
    expect(canonicalizeMyState(undefined)).toBeNull();
    expect(canonicalizeMyState('')).toBe('');
    expect(canonicalizeMyState('   ')).toBe('   ');
  });

  it('round-trips every canonical value unchanged (idempotency)', () => {
    for (const s of CANONICAL_MY_STATES) {
      expect(canonicalizeMyState(s)).toBe(s);
      expect(canonicalizeMyState(s)).toBe(canonicalizeMyState(canonicalizeMyState(s)!));
    }
  });

  it('maps PMS UPPERCASE list to canonical', () => {
    expect(canonicalizeMyState('JOHOR')).toBe('Johor');
    expect(canonicalizeMyState('PENANG')).toBe('Pulau Pinang');
    expect(canonicalizeMyState('KL')).toBe('Kuala Lumpur');
    expect(canonicalizeMyState('NEGERI SEMBILAN')).toBe('Negeri Sembilan');
    expect(canonicalizeMyState('MELAKA')).toBe('Melaka');
    expect(canonicalizeMyState('SELANGOR')).toBe('Selangor');
    expect(canonicalizeMyState('TERENGGANU')).toBe('Terengganu');
  });

  it('handles W.P. and Wilayah Persekutuan variants', () => {
    expect(canonicalizeMyState('W.P. Kuala Lumpur')).toBe('Kuala Lumpur');
    expect(canonicalizeMyState('WP KUALA LUMPUR')).toBe('Kuala Lumpur');
    expect(canonicalizeMyState('Wilayah Persekutuan Kuala Lumpur')).toBe('Kuala Lumpur');
    expect(canonicalizeMyState('W.P. Putrajaya')).toBe('Putrajaya');
    expect(canonicalizeMyState('W.P. Labuan')).toBe('Labuan');
  });

  it('handles common misspellings', () => {
    expect(canonicalizeMyState('Malacca')).toBe('Melaka');
    expect(canonicalizeMyState('Penang')).toBe('Pulau Pinang');
    expect(canonicalizeMyState('trengganu')).toBe('Terengganu');
    expect(canonicalizeMyState('N.S.')).toBe('Negeri Sembilan');
    expect(canonicalizeMyState('P.PINANG')).toBe('Pulau Pinang');
  });

  it('does NOT corrupt foreign state names when country is not MY', () => {
    expect(canonicalizeMyState('Guangdong', 'China')).toBe('Guangdong');
    expect(canonicalizeMyState('Central', 'Singapore')).toBe('Central');
    expect(canonicalizeMyState('California', 'USA')).toBe('California');
  });

  it('applies the mapping when country is Malaysia (any case)', () => {
    expect(canonicalizeMyState('PENANG', 'Malaysia')).toBe('Pulau Pinang');
    expect(canonicalizeMyState('penang', 'malaysia')).toBe('Pulau Pinang');
    expect(canonicalizeMyState('PENANG', 'MY')).toBe('Pulau Pinang');
    expect(canonicalizeMyState('PENANG', '')).toBe('Pulau Pinang'); // empty country still probes
  });

  it('returns unknown strings unchanged (never invents a state)', () => {
    expect(canonicalizeMyState('Atlantis')).toBe('Atlantis');
    expect(canonicalizeMyState('Mars')).toBe('Mars');
    expect(canonicalizeMyState('123')).toBe('123');
  });
});

describe('isCanonicalMyState', () => {
  it('accepts only exact canonical strings', () => {
    expect(isCanonicalMyState('Pulau Pinang')).toBe(true);
    expect(isCanonicalMyState('Kuala Lumpur')).toBe(true);
    expect(isCanonicalMyState('PENANG')).toBe(false);
    expect(isCanonicalMyState('KL')).toBe(false);
    expect(isCanonicalMyState('W.P. Kuala Lumpur')).toBe(false);
  });

  it('rejects null / empty', () => {
    expect(isCanonicalMyState(null)).toBe(false);
    expect(isCanonicalMyState(undefined)).toBe(false);
    expect(isCanonicalMyState('')).toBe(false);
  });
});
