import { describe, it, expect } from 'vitest';
import { canonicalizeVenue, venueKey } from './canonical-venue';

describe('canonicalizeVenue', () => {
  it('folds every known showroom alias to "2990s PJ"', () => {
    for (const raw of ['PJ Showroom', 'pj showroom', 'PJ-SHOWROOM', 'pjshowroom', '2990s pj', '2990 PJ', '2990spj']) {
      expect(canonicalizeVenue(raw)).toBe('2990s PJ');
    }
  });

  it('is idempotent on the canonical form', () => {
    expect(canonicalizeVenue('2990s PJ')).toBe('2990s PJ');
    expect(canonicalizeVenue(canonicalizeVenue('PJ Showroom'))).toBe('2990s PJ');
  });

  it('normalizes surrounding and inner whitespace before matching', () => {
    expect(canonicalizeVenue('  PJ   Showroom  ')).toBe('2990s PJ');
    expect(venueKey('  PJ   Showroom ')).toBe('pj showroom');
  });

  it('leaves an unknown venue unchanged (trimmed) — we only unify known aliases', () => {
    expect(canonicalizeVenue('KLCC Hall 3')).toBe('KLCC Hall 3');
    expect(canonicalizeVenue('  Sunway Pyramid ')).toBe('Sunway Pyramid');
  });

  it('treats blank / null / undefined as null (blanks stay blank)', () => {
    expect(canonicalizeVenue('')).toBeNull();
    expect(canonicalizeVenue('   ')).toBeNull();
    expect(canonicalizeVenue(null)).toBeNull();
    expect(canonicalizeVenue(undefined)).toBeNull();
  });
});
