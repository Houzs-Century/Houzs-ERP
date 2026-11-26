import { describe, expect, test } from 'vitest';
import { feeAmountSen, feeDiscountForAmount, lockedFeeSemantics } from './delivery-fee-amount';

describe('the delivery fee amount cell', () => {
  test('the owner case: a RM250 fee typed down to RM125 books a RM125 discount', () => {
    expect(feeDiscountForAmount(25000, 12500)).toBe(12500);
    expect(feeAmountSen(25000, 12500)).toBe(12500);
  });

  test('a reduction is the DIFFERENCE, not the number typed', () => {
    expect(feeDiscountForAmount(25000, 20000)).toBe(5000);
    expect(feeAmountSen(25000, 5000)).toBe(20000);
  });

  test('typing the fee back to its derived amount clears the discount', () => {
    expect(feeDiscountForAmount(25000, 25000)).toBe(0);
    expect(feeAmountSen(25000, 0)).toBe(25000);
  });

  test('a HIGHER figure yields no discount — a fee rise needs its own line', () => {
    expect(feeDiscountForAmount(25000, 30000)).toBe(0);
  });

  test('zero charges nothing and never discounts more than the line holds', () => {
    expect(feeDiscountForAmount(25000, 0)).toBe(25000);
    expect(feeDiscountForAmount(25000, -9900)).toBe(25000);
    expect(feeAmountSen(25000, 99900)).toBe(0);
  });

  test('an unpriced fee line cannot be discounted into a negative', () => {
    expect(feeDiscountForAmount(0, 12500)).toBe(0);
    expect(feeAmountSen(0, 0)).toBe(0);
  });

  test('an unreadable figure gives NO discount, not a full one', () => {
    expect(feeDiscountForAmount(25000, Number.NaN)).toBe(0);
    expect(feeDiscountForAmount(25000, Number.POSITIVE_INFINITY)).toBe(0);
    expect(feeDiscountForAmount(Number.NaN, 12500)).toBe(0);
    expect(feeAmountSen(25000, Number.NaN)).toBe(25000);
  });

  test('the result always satisfies the server bound 0 <= discount <= gross', () => {
    const gross = 25000;
    for (const typed of [-50000, -1, 0, 1, 12499, 12500, 24999, 25000, 25001, 999999]) {
      const d = feeDiscountForAmount(gross, typed);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(gross);
    }
  });
});

describe('the fee-vs-price verdict is locked per line', () => {
  test('REGRESSION 1: a fee line authored from 0 is a plain price, and STAYS one', () => {
    expect(lockedFeeSemantics(null, true, 0)).toBe(false);
    expect(feeAmountSen(0, 0)).toBe(0);
  });

  test('REGRESSION 2: the first keystroke must not flip the verdict ("stuck at RM 2")', () => {
    let v = lockedFeeSemantics(null, true, 0);
    expect(v).toBe(false);
    v = lockedFeeSemantics(v, true, 200);
    expect(v).toBe(false);
    v = lockedFeeSemantics(v, true, 2500);
    expect(v).toBe(false);
    v = lockedFeeSemantics(v, true, 25000);
    expect(v).toBe(false);
  });

  test('a line that ARRIVES priced edits as a fee, and stays one at net zero', () => {
    let v = lockedFeeSemantics(null, true, 25000);
    expect(v).toBe(true);
    v = lockedFeeSemantics(v, true, 25000);
    expect(v).toBe(true);
    expect(feeAmountSen(25000, 25000)).toBe(0);
  });

  test('a product line is never a fee, and leaving fee code resets the verdict', () => {
    expect(lockedFeeSemantics(null, false, 25000)).toBe(null);
    let v = lockedFeeSemantics(null, true, 25000);
    v = lockedFeeSemantics(v, false, 0);
    expect(v).toBe(null);
    expect(lockedFeeSemantics(v, true, 0)).toBe(false);
  });

  test('a nonsense gross locks as authoring, not as a fee', () => {
    expect(lockedFeeSemantics(null, true, Number.NaN)).toBe(false);
    expect(lockedFeeSemantics(null, true, -100)).toBe(false);
  });
});
