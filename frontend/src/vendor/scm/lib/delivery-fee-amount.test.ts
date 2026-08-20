import { describe, expect, test } from 'vitest';
import { feeAmountSen, feeDiscountForAmount } from './delivery-fee-amount';

describe('the delivery fee amount cell', () => {
  test('the owner case: a RM250 fee typed down to RM125 books a RM125 discount', () => {
    expect(feeDiscountForAmount(25000, 12500)).toBe(12500);
    // ...and the cell then reads back the amount that was typed.
    expect(feeAmountSen(25000, 12500)).toBe(12500);
  });

  test('a reduction is the DIFFERENCE, not the number typed', () => {
    // The 250 -> 125 case is a coincidence: half of 250 is also 125. Any other
    // pair separates "type the amount you want" from "type a discount", and
    // this is the case that catches the wrong one.
    expect(feeDiscountForAmount(25000, 20000)).toBe(5000);
    expect(feeAmountSen(25000, 5000)).toBe(20000);
  });

  test('typing the fee back to its derived amount clears the discount', () => {
    expect(feeDiscountForAmount(25000, 25000)).toBe(0);
    expect(feeAmountSen(25000, 0)).toBe(25000);
  });

  test('a HIGHER figure yields no discount — a fee rise needs its own line', () => {
    // Never a negative discount: that would raise the fee with no line naming
    // the money, which is the header back door the owner ruled out.
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
    // The input hands over whatever is in the box on every keystroke, and
    // `Number('-')` is NaN. Rounding that to 0 would read as "charge nothing"
    // and waive the fee mid-keystroke, so garbage fails towards charging the
    // derived amount. A real waiver is still reachable by typing 0, asserted
    // above.
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
