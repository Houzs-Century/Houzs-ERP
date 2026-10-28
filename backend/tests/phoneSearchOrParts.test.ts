import { describe, expect, test } from 'vitest';
import { escapeForOr, phoneSearchOrParts } from '../src/scm/lib/postgrest-search';
import { normalizePhone } from '../src/scm/shared/phone';

// The PHONE half of the SO / DO / SI list `.or()` free-text filter. Customer
// phones are stored E.164 ("+60123456789"), so a term with dashes/spaces or a
// local 0-prefix must be canonicalised before it can substring-match the store.
const parts = (raw: string) => phoneSearchOrParts(escapeForOr(raw), raw, normalizePhone);

describe('phoneSearchOrParts', () => {
  test('non-phone term emits only the raw predicate', () => {
    const p = parts('Acme');
    expect(p).toEqual(['phone.ilike.%Acme%']);
  });

  test('dashed/spaced local number also matches its E.164 digits', () => {
    const p = parts('012-345 6789');
    // raw (keeps separators) plus the normalised bare-digit form ("60123456789")
    expect(p[0]).toBe('phone.ilike.%012-345 6789%');
    expect(p).toContain('phone.ilike.%60123456789%');
    expect(p).toHaveLength(2);
  });

  test('local 0-prefixed number is rewritten to 60… so it hits the stored +60…', () => {
    const p = parts('0123456789');
    expect(p).toContain('phone.ilike.%60123456789%');
  });

  test('an already-E.164 digit fragment does not duplicate a predicate', () => {
    // "60123456789" normalises to itself; escaped already includes those digits.
    const p = parts('60123456789');
    expect(p).toEqual(['phone.ilike.%60123456789%']);
  });

  test('too-short numeric fragment stays a plain substring (no bogus normalise)', () => {
    // 3 digits is below the plausible-phone floor → normalizePhone returns null.
    const p = parts('345');
    expect(p).toEqual(['phone.ilike.%345%']);
  });
});
