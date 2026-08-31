import { describe, expect, test } from 'vitest';
import { paymentSaveOutcome } from './payment-save-outcome';

/* The money half of a Save. Leaving the page discards an unbooked row, so
   anything short of "all of them landed" must keep the page open — and say
   which rows, in words the operator can act on. */
describe('what a Save says about the payment rows it had to book', () => {
  test('nothing typed: silent, and the page may leave', () => {
    expect(paymentSaveOutcome({ committed: 0, failed: 0, blocked: [] }))
      .toEqual({ stay: false, message: null });
  });

  test('every row booked: still silent, still leaves', () => {
    expect(paymentSaveOutcome({ committed: 2, failed: 0, blocked: [] }))
      .toEqual({ stay: false, message: null });
  });

  test('a row was refused: the page STAYS, and says the order itself did save', () => {
    const out = paymentSaveOutcome({ committed: 1, failed: 1, blocked: [] });
    expect(out.stay).toBe(true);
    expect(out.message).toContain('The order was saved');
    expect(out.message).toContain('1 payment row saved');
    expect(out.message).toContain('1 could not be saved');
  });

  test('a row could not be sent at all: the page STAYS and names the reason', () => {
    const out = paymentSaveOutcome({
      committed: 0, failed: 0, blocked: ['Card: pick the bank'],
    });
    expect(out.stay).toBe(true);
    expect(out.message).toContain('still incomplete: Card: pick the bank');
  });

  test('several incomplete rows are all named, not counted', () => {
    const out = paymentSaveOutcome({
      committed: 0, failed: 0, blocked: ['Card: pick the bank', 'Cash: no amount'],
    });
    expect(out.message).toContain('Card: pick the bank; Cash: no amount');
  });
});
