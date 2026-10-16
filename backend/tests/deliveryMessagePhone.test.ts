// HC-0096: the delivery-arrangement blast sent to "+6060176800727" because it
// had its own digits-only normaliser that kept a doubled +60 (old SO headers
// written before #4582 still carry it). The blast must send the collapsed
// number, whatever shape the header holds.
import { describe, expect, test } from 'vitest';
import { blastPhone } from '../src/scm/routes/delivery-messages';

describe('delivery message recipient phone', () => {
  for (const stored of ['+6060176800727', '6060176800727', '60176800727', '+60176800727', '0176800727', '017-680 0727']) {
    test(`"${stored}" is sent to +60176800727`, () => {
      expect(blastPhone(stored)).toBe('+60176800727');
    });
  }

  test('a foreign number keeps its country code', () => {
    expect(blastPhone('+6591234567')).toBe('+6591234567');
  });

  test('a blank phone is skipped', () => {
    expect(blastPhone('')).toBeNull();
    expect(blastPhone(null)).toBeNull();
  });
});
