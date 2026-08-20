import { describe, expect, test } from 'vitest';
import { editsFeeAsDiscount, feeAmountSen, feeDiscountForAmount } from './delivery-fee-amount';

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

describe('which lines edit as a fee at all', () => {
  test('REGRESSION: a fee line being authored on a NEW SO is a plain price', () => {
    // The shipped bug. A hand-added "Delivery fee" line starts at 0, so
    // reading a typed 250 as "charge 250" booked a discount of 0, never wrote
    // a price, and the cell snapped back to RM 0 on blur.
    expect(editsFeeAsDiscount(true, 0)).toBe(false);
    expect(feeAmountSen(0, 0)).toBe(0);
  });

  test('a fee that HAS been derived edits as an amount to charge', () => {
    expect(editsFeeAsDiscount(true, 25000)).toBe(true);
  });

  test('a fee discounted all the way to zero still edits as a fee', () => {
    // The GROSS is what decides, not the net — otherwise waiving a fee would
    // flip the cell back to price-editing and the next keystroke would mean
    // something different from the last one.
    expect(editsFeeAsDiscount(true, 25000)).toBe(true);
    expect(feeAmountSen(25000, 25000)).toBe(0);
  });

  test('a product line is never a fee, priced or not', () => {
    expect(editsFeeAsDiscount(false, 0)).toBe(false);
    expect(editsFeeAsDiscount(false, 25000)).toBe(false);
  });

  test('a nonsense gross does not turn a line into a fee', () => {
    expect(editsFeeAsDiscount(true, Number.NaN)).toBe(false);
    expect(editsFeeAsDiscount(true, -100)).toBe(false);
  });
});
