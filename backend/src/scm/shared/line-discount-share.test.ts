import { describe, expect, it } from 'vitest';
import { lineDiscountShare } from './line-discount-share';

/* Regression: a partial DO / invoice copied the WHOLE line discount onto each
   part, so 4 units with RM100 off delivered 2 + 2 took RM100 off twice. */
describe('lineDiscountShare: a line discount split across partial deliveries / invoices', () => {
  it('a whole-line move carries the whole discount', () => {
    expect(lineDiscountShare(10000, 4, 0, 4)).toBe(10000);
  });

  it('4 units with RM100 off, delivered 2 + 2, carry RM50 each, never RM100 twice', () => {
    const first = lineDiscountShare(10000, 4, 0, 2);
    const second = lineDiscountShare(10000, 4, 2, 2);
    expect([first, second]).toEqual([5000, 5000]);
    expect(first + second).toBe(10000);
  });

  it('uneven splits add up to the discount exactly; the last part takes the rounding', () => {
    const pieces = [1, 1, 1].map((q, i) => lineDiscountShare(1000, 3, i, q));
    expect(pieces).toEqual([333, 334, 333]);
    expect(pieces.reduce((s, v) => s + v, 0)).toBe(1000);
    const odd = [lineDiscountShare(1001, 7, 0, 2), lineDiscountShare(1001, 7, 2, 4), lineDiscountShare(1001, 7, 6, 1)];
    expect(odd.reduce((s, v) => s + v, 0)).toBe(1001);
    expect(odd.every((v) => Number.isInteger(v))).toBe(true);
  });

  it('every split of a line sums to its discount in integer sen', () => {
    for (const qty of [1, 2, 3, 5, 7, 12]) {
      for (const disc of [1, 99, 1000, 12345]) {
        let moved = 0;
        let sum = 0;
        while (moved < qty) {
          const step = Math.min(qty - moved, 1 + (moved % 3));
          sum += lineDiscountShare(disc, qty, moved, step);
          moved += step;
        }
        expect(sum).toBe(disc);
      }
    }
  });

  it('quantity past the line (over-delivery) carries nothing extra', () => {
    expect(lineDiscountShare(4000, 2, 2, 1)).toBe(0);
    expect(lineDiscountShare(4000, 2, 1, 5)).toBe(2000);
  });

  it('no discount, or a line with no quantity, carries nothing', () => {
    expect(lineDiscountShare(0, 2, 0, 1)).toBe(0);
    expect(lineDiscountShare(500, 0, 0, 1)).toBe(0);
  });
});
