import { describe, expect, test } from 'vitest';
import { phonesMatch } from '../src/services/caseTracking';

// The public /track form asks a customer for their ASSR number and their phone.
// Before phonesMatch() the comparison was cleanPhone(a) !== cleanPhone(b), and
// cleanPhone only strips `+ & - space`. That reconciles punctuation and stops
// there, so it could not see across the country-code boundary: a Malaysian
// typing their own number types the leading 0, the API stores E.164, and the
// two never compared equal. The customer was told "No matching case", which
// reads as "we have no record of you" rather than "wrong format" — and the
// form offers no format hint, because there was not supposed to be a wrong one.
//
// The first block is the regression. The rest pin that widening the match did
// not weaken it: a different number must still be a different number.
describe('phonesMatch — the /track regression', () => {
  test('the local 0 form matches the stored +60 form (the reported break)', () => {
    expect(phonesMatch('+60123456789', '0123456789')).toBe(true);
  });

  test('and in the other direction, for rows written before normalisation existed', () => {
    expect(phonesMatch('0123456789', '+60123456789')).toBe(true);
  });

  test('punctuation is still irrelevant, in every combination', () => {
    expect(phonesMatch('+60123456789', '012-345 6789')).toBe(true);
    expect(phonesMatch('+60 12-345 6789', '0123456789')).toBe(true);
    expect(phonesMatch('012 345 6789', '60123456789')).toBe(true);
  });

  test('a bare national number with no prefix at all still matches', () => {
    expect(phonesMatch('+60123456789', '123456789')).toBe(true);
  });
});

describe('phonesMatch — it must not match numbers that differ', () => {
  test('a different subscriber number does not match', () => {
    expect(phonesMatch('+60123456789', '0123456788')).toBe(false);
  });

  test('a different Malaysian carrier prefix does not match', () => {
    expect(phonesMatch('+60123456789', '0113456789')).toBe(false);
  });

  test('the same digits under a DIFFERENT country code do not match', () => {
    // +65 is Singapore. An explicit country code is preserved by
    // normalizePhone, so this must not collapse onto the Malaysian number.
    expect(phonesMatch('+60123456789', '+6512345678')).toBe(false);
  });

  test('null / empty on either side is never a match', () => {
    expect(phonesMatch(null, '0123456789')).toBe(false);
    expect(phonesMatch('+60123456789', null)).toBe(false);
    expect(phonesMatch('', '')).toBe(false);
    expect(phonesMatch('+60123456789', '')).toBe(false);
  });
});

describe('phonesMatch — the fallback can only ADD matches, never remove one', () => {
  test('a value normalizePhone declines still matches itself', () => {
    // Too short for normalizePhone (returns null), so the comparison falls
    // back to cleanPhone equality. A legacy row like this must keep working.
    expect(phonesMatch('1234', '1234')).toBe(true);
    expect(phonesMatch('12-34', '1234')).toBe(true);
  });

  test('two different unnormalisable values still do not match', () => {
    expect(phonesMatch('1234', '5678')).toBe(false);
  });

  test('an unnormalisable value does not match a normalisable one', () => {
    expect(phonesMatch('1234', '+60123456789')).toBe(false);
  });
});
