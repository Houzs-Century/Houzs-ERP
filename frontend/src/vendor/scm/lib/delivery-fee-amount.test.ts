import { describe, expect, test } from 'vitest';
import { feeAmountSen, feeDiscountForAmount, lockedFeeSemantics } from './delivery-fee-amount';

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

describe('the fee-vs-price verdict is locked per line', () => {
  test('REGRESSION 1: a fee line authored from 0 is a plain price, and STAYS one', () => {
    // The first shipped bug: gross 0 read a typed 250 as "charge 250" and
    // booked nothing.
    expect(lockedFeeSemantics(null, true, 0)).toBe(false);
    expect(feeAmountSen(0, 0)).toBe(0);
  });

  test('REGRESSION 2: the first keystroke must not flip the verdict ("stuck at RM 2")', () => {
    // The second shipped bug, simulated keystroke by keystroke. Typing "250"
    // on a fresh fee line: after "2" the unit price is RM 2, the gross is
    // positive, and a LIVE verdict flipped the cell into amount-to-charge —
    // "25" then read as a target above the RM 2 gross, booked no discount,
    // and the sync-back pinned the box at 2.00.
    let v = lockedFeeSemantics(null, true, 0);      // line added: authoring
    expect(v).toBe(false);
    v = lockedFeeSemantics(v, true, 200);           // typed "2" -> gross RM 2
    expect(v).toBe(false);                          // still a plain price
    v = lockedFeeSemantics(v, true, 2500);          // typed "25"
    expect(v).toBe(false);
    v = lockedFeeSemantics(v, true, 25000);         // typed "250"
    expect(v).toBe(false);                          // RM 250 lands as the price
  });

  test('a line that ARRIVES priced edits as a fee, and stays one at net zero', () => {
    // The detail page: the gross exists before the first render. Waiving it
    // to net 0 must not flip the verdict back to price-editing either.
    let v = lockedFeeSemantics(null, true, 25000);
    expect(v).toBe(true);
    v = lockedFeeSemantics(v, true, 25000);         // discounted to net 0: gross unchanged
    expect(v).toBe(true);
    expect(feeAmountSen(25000, 25000)).toBe(0);
  });

  test('a product line is never a fee, and leaving fee code resets the verdict', () => {
    expect(lockedFeeSemantics(null, false, 25000)).toBe(null);
    // Fee line -> operator picks a product over it -> back to a fee code
    // later: the old verdict must not leak across.
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
