import { describe, expect, test } from 'vitest';
import { collapseDoubledMalaysianPrefix, normalizePhone, splitE164, combineE164 } from '../src/scm/shared/phone';

// BUG-114 (Syu, 2026-10-13): HC Delivery sheet rows for HC-SO-2609-096 / -097 /
// -126 / -132 / -165 printed the customer phone as "6060192689927",
// "60601114000133", ... The ERP stored "+60" + a number that already carried
// 60 (or the trunk 0). No Malaysian national number starts with 60 or 0, so
// the extra prefix is dropped on every write.
describe('the doubled +60 from the BUG-114 sheet rows collapses to one', () => {
  const cases: Array<[string, string]> = [
    ['+6060192689927', '+60192689927'],
    ['+60601114000133', '+601114000133'],
    ['+6060167543696', '+60167543696'],
    ['+6060109396802', '+60109396802'],
    ['+60601167860401', '+601167860401'],
  ];
  for (const [stored, fixed] of cases) {
    test(stored, () => {
      expect(normalizePhone(stored)).toBe(fixed);
      expect(normalizePhone(stored.slice(1))).toBe(fixed);
    });
  }

  test('the trunk-0 variant: "+60" in front of a pasted 019...', () => {
    expect(normalizePhone('+600192689927')).toBe('+60192689927');
    expect(normalizePhone('+60 019-268 9927')).toBe('+60192689927');
  });

  test('a triple prefix still lands on one', () => {
    expect(normalizePhone('+606060192689927')).toBe('+60192689927');
  });
});

describe('numbers that must not be touched', () => {
  test('ordinary Malaysian mobile and landline', () => {
    expect(normalizePhone('+60192689927')).toBe('+60192689927');
    expect(normalizePhone('+601114000133')).toBe('+601114000133');
    expect(normalizePhone('+60312345678')).toBe('+60312345678');
    expect(normalizePhone('06-282 1234')).toBe('+6062821234');
  });

  test('foreign numbers', () => {
    expect(normalizePhone('+65 6123 4567')).toBe('+6561234567');
    expect(normalizePhone('+6591234567')).toBe('+6591234567');
  });

  test('a doubled-looking value with no plausible MY length is left as it was', () => {
    expect(collapseDoubledMalaysianPrefix('6060123')).toBe('6060123');
    expect(collapseDoubledMalaysianPrefix('60601234567890123')).toBe('60601234567890123');
  });

  test('a doubled prefix over a mobile a digit short is not rewritten (plan run 2026-10-13)', () => {
    expect(normalizePhone('+606012295388')).toBe('+606012295388');
    expect(normalizePhone('+606017268613')).toBe('+606017268613');
  });

  test('a doubled prefix over an 8-digit landline still collapses', () => {
    expect(normalizePhone('+606078441319')).toBe('+6078441319');
    expect(normalizePhone('+606098009078')).toBe('+6098009078');
  });
});

describe('the +60 picker (split / combine) cleans a pasted full number', () => {
  test('pasted "60192689927" or "0192689927" behind +60 stores one 60', () => {
    expect(combineE164('60', '6060192689927')).toBe('+60192689927');
    expect(combineE164('60', '0192689927')).toBe('+60192689927');
    expect(combineE164('60', '192689927')).toBe('+60192689927');
  });

  test('a stored doubled value opens with the national part only', () => {
    expect(splitE164('+6060192689927')).toEqual({ dial: '60', national: '192689927' });
  });

  test('another country is not rewritten', () => {
    expect(combineE164('65', '61234567')).toBe('+6561234567');
  });
});
