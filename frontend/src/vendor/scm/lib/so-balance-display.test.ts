import { describe, expect, test } from 'vitest';
import { soRowBalanceCenti, soBalanceCellClass } from './so-balance-display';

/* The SO list Balance column read `balance_centi_live ?? balance_centi ?? 0`
   and drew every value in the same ink. `balance_centi_live` is GREATEST(...,0)
   in the payment-totals view, so an over-collected order rendered RM 0.00 —
   the row could not tell an exactly-settled order from one carrying RM 250 of
   the customer's money. Owner 2026-08-16: it must show negative, in red. */
describe('soRowBalanceCenti — which field the column reads', () => {
  test('prefers the signed stamp, negative and all', () => {
    expect(soRowBalanceCenti({
      balance_signed_centi: -250_00, balance_centi_live: 0, balance_centi: 4250_00,
    })).toBe(-250_00);
  });

  test('a signed 0 is a real answer, not an absent one', () => {
    expect(soRowBalanceCenti({ balance_signed_centi: 0, balance_centi: 4250_00 })).toBe(0);
  });

  /* Mid-deploy the list can hold a payload from the previous backend. It must
     land on the number this column ALREADY showed — a stale row reading 0 is
     the old behaviour; a stale row reading a wrong sign would be a new bug. */
  test('an older payload degrades to the floored view column, then the header', () => {
    expect(soRowBalanceCenti({ balance_centi_live: 200_00, balance_centi: 400_00 })).toBe(200_00);
    expect(soRowBalanceCenti({ balance_centi: 400_00 })).toBe(400_00);
    expect(soRowBalanceCenti({})).toBe(0);
  });

  test('an explicit null is skipped, not read as 0', () => {
    expect(soRowBalanceCenti({ balance_signed_centi: null, balance_centi_live: 150_00 })).toBe(150_00);
  });
});

describe('soBalanceCellClass — red is the requirement, not decoration', () => {
  test('a negative balance is red and weighted', () => {
    expect(soBalanceCellClass(-1)).toContain('text-err');
    expect(soBalanceCellClass(-250_00)).toContain('font-semibold');
  });

  test('zero and positive keep the ordinary ink', () => {
    expect(soBalanceCellClass(0)).toContain('text-ink');
    expect(soBalanceCellClass(0)).not.toContain('text-err');
    expect(soBalanceCellClass(200_00)).toContain('text-ink');
    expect(soBalanceCellClass(200_00)).not.toContain('text-err');
  });

  test('the money font and size are unchanged on both sides', () => {
    expect(soBalanceCellClass(-1)).toContain('font-money text-[13px]');
    expect(soBalanceCellClass(1)).toContain('font-money text-[13px]');
  });
});
