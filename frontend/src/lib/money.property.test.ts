import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseMoneyToSen, parseQuantity, senToRm } from './money';
import { fmtSen } from '../vendor/shared/format';

const MAX_SEN = 999_999_999_999;
const sen = fc.integer({ min: 0, max: MAX_SEN });

describe('money parse/format properties', () => {
  it('parseMoneyToSen(fmtSen(x)) returns x', () => {
    fc.assert(
      fc.property(sen, (x) => {
        expect(parseMoneyToSen(fmtSen(x))).toEqual({ ok: true, sen: x, empty: false });
      }),
    );
  });

  it('a negative fmtSen round-trips when negatives are allowed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_SEN }), (x) => {
        expect(parseMoneyToSen(fmtSen(-x), undefined, { allowNegative: true })).toEqual({ ok: true, sen: -x, empty: false });
      }),
    );
  });

  it('parsing the RM number senToRm gives back returns the same sen', () => {
    fc.assert(
      fc.property(sen, (x) => {
        expect(parseMoneyToSen(senToRm(x))).toEqual({ ok: true, sen: x, empty: false });
      }),
    );
  });

  it('a string with more than 2 decimals is refused, never rounded', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.integer({ min: 1, max: 9 }), fc.stringMatching(/^\d{2}$/), (whole, last, two) => {
        expect(parseMoneyToSen(`${String(whole)}.${two}${String(last)}`).ok).toBe(false);
      }),
    );
  });

  it('parseQuantity reads a 3-decimal string exactly', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 999 }), (whole, frac) => {
        const text = `${String(whole)}.${String(frac).padStart(3, '0')}`;
        expect(parseQuantity(text)).toEqual({ ok: true, sen: whole * 1000 + frac, empty: false });
      }),
    );
  });
});
